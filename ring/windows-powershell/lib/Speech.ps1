# ============================================================
#  Speech.ps1 — 离线语音输入
#
#  用 Windows 自带的 System.Speech（SAPI）把说的话转成文字。
#  不联网、不要密钥、断网也能用，录音不外传。
#  代价：这是 SAPI 8.0 时代的老引擎，**短句够用，长段落不行**
#  （实测「帮我把这张照片调成胶片感」会听成「当我把这张照片条成交片感」——
#  同音字级别的错，句子结构是对的）。所以整套设计是「按住说一句、
#  松开就出字」，而不是让你口述一大段。
#
#  ------------------------------------------------------------
#  **为什么事件接收端要写成 C#（这是踩出来的，别再改回脚本块）**
#
#  SAPI 的 SpeechRecognized 是在线程池线程上抛出来的。把 PowerShell 的
#  脚本块直接挂成事件处理器，等于让一个外来线程闯进正在跑脚本的 runspace。
#  实测结果不是「抛异常」，而是**整个进程硬崩**——合成语音第一句话说完的
#  那一刻必崩，catch 都轮不到（用 WAV 复现过三次，每次都死在 3.7 秒左右，
#  正是第一句结束的位置；挂麦克风时只是没说话才侥幸没崩）。
#
#  所以事件的接收端放在 C# 里：回调只做一件事，把结果塞进
#  ConcurrentQueue。PowerShell 侧用定时器来取队列，全程在自己线程上跑。
#  这样改造之后同样的 WAV 测试拿到 3 段结果、进程安然无恙。
#
#  ------------------------------------------------------------
#  另一条同样重要的经验：**没有「到点就返回」的同步识别**。
#  Recognize(TimeSpan) 看似能在超时后返回，实测在麦克风上它照样阻塞
#  0.9～32 秒 —— 超时只作用于「等待开始说话」，一旦判定有声音就等到说完。
#  所以不要试图用它做轮询式识别，push-to-talk 的「松开即停」必须靠
#  RecognizeAsyncCancel（实测 ~90ms 返回，够快）。
#
#  只在按住热键 / 点开麦克风按钮时才开麦，其余时间引擎是关着的。
# ============================================================

$script:Voice = @{
    Pump          = $null          # Huanmeng.Speech.Pump（C#）
    Ready         = $false
    Error         = ''             # 结构性不可用（没装中文引擎），一旦写上不再重试
    LastError     = ''             # 这一次失败的原因，下次还会重试
    Listening     = $false
    Stopping      = $false
    Armed         = $false         # 热键已按下、还没松开
    CommitOnStop  = $true
    Segments      = $null          # 本轮已定稿的句子
    Partial       = ''
    StopDeadline  = $null
    Hotkey        = ''
    HotkeyOk      = $false
    HotkeyVk      = 0
    HotkeyMods    = 0
    PollTimer     = $null
    Ticks         = 0              # 心跳次数。排查「松手不收尾」时看它
    InsertFrom    = -1             # 本轮从输入框的哪个位置开始插入（Esc 撤销要用）
    Inserted      = 0              # 本轮一共插入多少个字符
}

$script:HK_VOICE = 0x484D02
$script:VK_CTRL  = 0x11
$script:VK_ALT   = 0x12
$script:VK_SHIFT = 0x10

$script:SpeechCompiled = $false

# ---------- C# 事件接收端 ----------

function Initialize-SpeechPump {
    if ($script:SpeechCompiled) { return $true }

    try {
        Add-Type -AssemblyName System.Speech -ErrorAction Stop
    } catch {
        return $false
    }

    try {
        Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Speech.Recognition;

namespace Huanmeng.Speech {

    /// 一条识别结果。C# 侧只负责搬运，不碰任何 PowerShell 对象。
    public class Heard {
        public string Text;
        public double Confidence;
    }

    /// <summary>
    /// SAPI 事件的接收端，**必须留在 C# 里**。
    ///
    /// 把 PowerShell 脚本块挂成事件处理器的话，SAPI 会在线程池线程上
    /// 闯进正在跑脚本的 runspace —— 实测直接硬崩整个进程（不是异常，
    /// catch 都轮不到）。这里回调只做一次入队，PowerShell 用定时器来取。
    /// </summary>
    public class Pump : IDisposable {

        public readonly ConcurrentQueue<Heard> Results = new ConcurrentQueue<Heard>();
        public volatile bool Completed;
        public volatile bool Rejected;
        public volatile string LastError = "";

        private SpeechRecognitionEngine _engine;

        public static RecognizerInfo FindRecognizer(string langPrefix) {
            foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers()) {
                if (info.Culture.Name.StartsWith(langPrefix, StringComparison.OrdinalIgnoreCase)) { return info; }
            }
            return null;
        }

        public bool Init(RecognizerInfo info, int confidenceThreshold) {
            try {
                _engine = new SpeechRecognitionEngine(info);
                _engine.LoadGrammar(new DictationGrammar());
                try { _engine.UpdateRecognizerSetting("CFGConfidenceRejectionThreshold", confidenceThreshold); } catch { }
                _engine.SpeechRecognized += OnRecognized;
                _engine.SpeechRecognitionRejected += OnRejected;
                _engine.RecognizeCompleted += OnCompleted;
                Completed = false;
                Rejected = false;
                LastError = "";
                return true;
            } catch (Exception ex) {
                LastError = ex.Message;
                return false;
            }
        }

        private void OnRecognized(object sender, SpeechRecognizedEventArgs e) {
            Heard h = new Heard();
            h.Text = e.Result.Text;
            h.Confidence = e.Result.Confidence;
            Results.Enqueue(h);
        }

        private void OnRejected(object sender, SpeechRecognitionRejectedEventArgs e) { Rejected = true; }
        private void OnCompleted(object sender, RecognizeCompletedEventArgs e) { Completed = true; }

        /// 置信度门槛：低于它的直接丢弃，免得把环境噪音变成一句胡话塞进输入框
        public void SetThreshold(int value) {
            try { _engine.UpdateRecognizerSetting("CFGConfidenceRejectionThreshold", value); } catch { }
        }

        /// <summary>
        /// 挂上麦克风。
        ///
        /// **不能只是 Cancel 完就直接设输入。** RecognizeAsyncCancel 是异步的，
        /// 调用返回时引擎往往还停在「正在识别」状态，紧接着设输入就会报
        /// "Cannot perform this operation while the recognizer is doing recognition"。
        /// 表现就是「第一次能用，第二次说打不开麦克风」——
        /// 用户完全看不出这是竞态，只会觉得这东西时灵时不灵。
        /// 这里改成带退避的重试：设不上就等一会儿再试，最多等 1 秒。
        /// </summary>
        public bool SetMic() { return AttachInput(0, null); }

        /// 从 WAV 文件读。生产路径用不到（那是麦克风），
        /// 但留着它整条链路就能脱离麦克风做自动化测试 ——
        /// 上面那些「事件回调会崩」「超时不生效」的结论都是靠它测出来的。
        public bool SetWaveFile(string path) { return AttachInput(1, path); }

        private bool AttachInput(int kind, string path) {
            try { _engine.RecognizeAsyncCancel(); } catch { }

            Exception last = null;
            for (int attempt = 0; attempt < 40; attempt++) {
                try {
                    if (kind == 0) { _engine.SetInputToDefaultAudioDevice(); }
                    else { _engine.SetInputToWaveFile(path); }
                    LastError = "";
                    return true;
                } catch (Exception ex) {
                    last = ex;
                    System.Threading.Thread.Sleep(25);
                }
            }
            LastError = last == null ? "设置音频输入失败" : last.Message;
            return false;
        }

        public void SetNull() { try { _engine.SetInputToNull(); } catch { } }
        public void StartAsync() { _engine.RecognizeAsync(RecognizeMode.Multiple); }
        public void StopAsync() { try { _engine.RecognizeAsyncStop(); } catch { } }
        public void CancelAsync() { try { _engine.RecognizeAsyncCancel(); } catch { } }

        public void Dispose() {
            if (_engine != null) { try { _engine.Dispose(); } catch { } _engine = null; }
        }
    }
}
'@
        $script:SpeechCompiled = $true
        return $true
    } catch {
        $script:Voice.LastError = "语音组件编译失败：$($_.Exception.Message)"
        Write-CrashLog "语音组件编译失败: $($_.Exception.Message)"
        return $false
    }
}

# ---------- 可用性 ----------

function Test-SpeechAvailable {
    $info = @{ Ok = $false; Name = ''; Culture = ''; Error = '' }

    if (-not (Initialize-SpeechPump)) {
        $info.Error = '这台机器上没有 System.Speech 组件，装不了语音输入'
        return $info
    }

    try {
        $zh = [Huanmeng.Speech.Pump]::FindRecognizer('zh')
    } catch {
        $info.Error = "读不到语音识别引擎列表：$($_.Exception.Message)"
        return $info
    }

    if ($null -eq $zh) {
        $all = @()
        try { $all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() } catch { }
        if ($all.Count -eq 0) {
            $info.Error = '系统里一个语音识别引擎都没有。到「设置 → 时间和语言 → 语言和区域」里给中文装上语音识别'
        } else {
            $info.Error = "只找到非中文的识别引擎（$($all[0].Culture.Name)）。中文语音输入需要装中文语音识别组件"
        }
        return $info
    }

    $info.Ok = $true
    $info.Name = $zh.Name
    $info.Culture = $zh.Culture.Name
    return $info
}

$script:Voice.Available = $null
function Test-SpeechUsable {
    if ($null -ne $script:Voice.Available) { return $script:Voice.Available }
    $script:Voice.Available = Test-SpeechAvailable
    return $script:Voice.Available
}

function Test-VoiceButtonVisible {
    if (-not $script:Cfg) { return $false }
    if (-not $script:Cfg.speech -or -not $script:Cfg.speech.enabled) { return $false }
    return (Test-SpeechUsable).Ok
}

# 懒加载：第一次真要听的时候才建引擎，从不使用语音的用户不付这份开销
function Initialize-SpeechEngine {
    if ($script:Voice.Ready) { return $true }
    if ($script:Voice.Error) { return $false }
    if (-not (Initialize-SpeechPump)) { return $false }

    try {
        $zh = [Huanmeng.Speech.Pump]::FindRecognizer('zh')
        if ($null -eq $zh) { $script:Voice.Error = (Test-SpeechAvailable).Error; return $false }

        $threshold = 35
        if ($script:Cfg -and $script:Cfg.speech) {
            $threshold = [int][Math]::Max(0, [Math]::Min(100, [double]$script:Cfg.speech.confidence * 100))
        }

        $pump = New-Object Huanmeng.Speech.Pump
        if (-not $pump.Init($zh, $threshold)) {
            # 只记 LastError，不写 Error —— Error 是「结构性不可用」，写上去就不再重试，
            # 而建引擎失败可能只是一次性的（设备被占、驱动刚重启）
            $script:Voice.LastError = "语音引擎启动失败：$($pump.LastError)"
            Write-CrashLog "语音引擎: $($pump.LastError)"
            return $false
        }

        $script:Voice.Pump = $pump
        $script:Voice.Ready = $true
        $script:Voice.Error = ''
        $script:Voice.LastError = ''
        return $true
    } catch {
        $script:Voice.LastError = "语音引擎启动失败：$($_.Exception.Message)"
        Write-CrashLog "语音引擎: $($_.Exception.Message)"
        return $false
    }
}

# ---------- 开始 / 结束 ----------

function Start-VoiceCapture {
    param([string]$Source = 'button')

    if ($script:Voice.Listening) { return $true }
    if (-not $script:Cfg.speech.enabled) {
        if ($script:Notify) { & $script:Notify '语音输入已在偏好设置里关掉了' 'warn' }
        return $false
    }
    if (-not (Initialize-SpeechEngine)) {
        $why = [string]$script:Voice.Error
        if (-not $why) { $why = [string]$script:Voice.LastError }
        if (-not $why) { $why = '语音引擎起不来' }
        if ($script:Notify) { & $script:Notify $why 'error' }
        if ((Get-BubbleMode) -ne '') { Set-BubbleHint "语音用不了：$why" }
        return $false
    }

    $pump = $script:Voice.Pump
    $b = $script:Bubble
    # 麦克风只会把话送进输入框。没有输入框的时候（看图、看长文本）别开麦，
    # 否则用户对着麦克风说完，字不知道跑哪儿去了
    if (-not $b.Input) {
        if ($script:Notify) { & $script:Notify '先把要输入的那个气泡打开再说话' 'warn' }
        return $false
    }

    $script:Voice.Segments = New-Object System.Collections.ArrayList
    $script:Voice.Partial = ''
    $script:Voice.Stopping = $false
    $script:Voice.StopDeadline = $null
    $script:Voice.LastError = ''

    # 记下插入起点，Esc 取消时要把这一段原样撤掉
    Clear-BubblePlaceholder -Box $b.Input
    $script:Voice.InsertFrom = $b.Input.SelectionStart
    $script:Voice.Inserted = 0

    # 先清掉上一轮可能残留的异步状态，否则接着开麦会报
    # 「Cannot perform this operation while the recognizer is doing recognition」
    $pump.CancelAsync()

    if (-not $pump.SetMic()) {
        $script:Voice.LastError = '打不开麦克风 —— 设置 → 隐私和安全性 → 麦克风，把「允许桌面应用访问麦克风」打开'
        if ($script:Notify) { & $script:Notify $script:Voice.LastError 'error' }
        if ((Get-BubbleMode) -ne '') { Set-BubbleHint $script:Voice.LastError }
        Write-CrashLog "语音: $($pump.LastError)"
        return $false
    }

    try {
        $pump.StartAsync()
    } catch {
        $script:Voice.LastError = "启动识别失败：$($_.Exception.Message)"
        if ($script:Notify) { & $script:Notify $script:Voice.LastError 'error' }
        Write-CrashLog "语音: $($_.Exception.Message)"
        return $false
    }

    $script:Voice.Listening = $true
    Start-VoicePoll
    Update-BubbleMicButton
    Set-BubbleHint '正在听… 松开就出字（说错了按 Esc 取消）'
    Write-Dbg "语音：开始收音（来源 $Source）"
    return $true
}

# 松开热键 / 再点一次麦克风按钮都走这里。
#
# 这里**不调 RecognizeAsyncStop()**：实测它虽然 60ms 就返回，
# 但 RecognizeCompleted 回调在本机根本不来（单独测过），等于白调。
# 真正收尾的是「宽限期 + Cancel」——给 SAPI 几百毫秒把最后一句吐出来，
# 到点直接 Cancel 解绑麦克风。这套在没等到 RecognizeCompleted 时也成立。
function Stop-VoiceCapture {
    param([bool]$Commit = $true)

    if (-not $script:Voice.Listening) { return }
    if ($script:Voice.Stopping) { return }

    $script:Voice.Stopping = $true
    $script:Voice.CommitOnStop = $Commit
    $script:Voice.StopDeadline = (Get-Date).AddMilliseconds(700)
}

# Esc 取消：把这一轮插进去的字原样撤掉
function Cancel-VoiceCapture {
    if (-not $script:Voice.Listening) { return }
    $script:Voice.Stopping = $true
    $script:Voice.CommitOnStop = $false
    $script:Voice.StopDeadline = (Get-Date).AddMilliseconds(60)
}

function Toggle-VoiceCapture {
    if ($script:Voice.Listening) { Stop-VoiceCapture -Commit $true }
    else { [void](Start-VoiceCapture -Source 'button') }
}

function Get-VoiceState {
    return @{
        Listening = $script:Voice.Listening
        Ready     = $script:Voice.Ready
        Error     = $script:Voice.Error
        LastError = $script:Voice.LastError
        Hotkey    = $script:Voice.Hotkey
        HotkeyOk  = $script:Voice.HotkeyOk
        Ticks     = $script:Voice.Ticks
    }
}

# ---------- 把识别结果落进输入框 ----------

function Insert-VoiceText {
    param([string]$Text)

    $box = $script:Bubble.Input
    if (-not $box) { return }
    if (-not $Text) { return }

    $text = $Text.Trim()
    if (-not $text) { return }

    Clear-BubblePlaceholder -Box $box

    $existing = [string]$box.Text
    $head = $existing.Substring(0, [Math]::Min($box.SelectionStart, $existing.Length))
    $tail = ''
    if ($box.SelectionStart -lt $existing.Length) {
        $tail = $existing.Substring($box.SelectionStart + $box.SelectionLength)
    }

    # 中英混排补空格：上一段以英文/数字结尾、这一段又以英文/数字开头，
    # 不加空格会粘成一个词。中文之间不需要，加了反而怪
    $sep = ''
    if ($head -and [regex]::IsMatch($head, '[A-Za-z0-9]$') -and [regex]::IsMatch($text, '^[A-Za-z0-9]')) {
        $sep = ' '
    }

    $box.Text = $head + $sep + $text + $tail
    $caret = $head.Length + $sep.Length + $text.Length
    $box.SelectionStart = $caret
    $box.SelectionLength = 0
    $box.ForeColor = $script:BubbleTheme.fg
    $box.Focus()

    if ($script:Voice.Inserted -ge 0) { $script:Voice.Inserted += $sep.Length + $text.Length }
}

# Esc 撤销：把这一轮说的字从输入框里删掉，手动打的字保留
function Undo-VoiceText {
    $box = $script:Bubble.Input
    if (-not $box) { return }
    if ($script:Voice.InsertFrom -lt 0 -or $script:Voice.Inserted -le 0) { return }

    $existing = [string]$box.Text
    $from = $script:Voice.InsertFrom
    if ($from -ge $existing.Length) { return }
    $len = [Math]::Min($script:Voice.Inserted, $existing.Length - $from)

    $box.Text = $existing.Substring(0, $from) + $existing.Substring($from + $len)
    $box.SelectionStart = $from
    $box.SelectionLength = 0
    $script:Voice.Inserted = 0
}

# ---------- 心跳：取结果 + 判松开 ----------

function Update-VoiceInput {
    $pump = $script:Voice.Pump
    if ($null -eq $pump) { return }

    # 取走 C# 那边攒下的识别结果（全程在 UI 线程上，不碰 SAPI 的回调线程）
    $h = $null
    while ($pump.Results.TryDequeue([ref]$h)) {
        if ($null -eq $h) { continue }
        if (-not $script:Voice.Listening) { continue }

        $text = [string]$h.Text
        if (-not $text.Trim()) { continue }

        $conf = [double]$h.Confidence
        $minConf = 0.0
        if ($script:Cfg -and $script:Cfg.speech) { $minConf = [double]$script:Cfg.speech.confidence }

        if ($conf -ge $minConf) {
            [void]$script:Voice.Segments.Add($text)
            $script:Voice.Partial = ''
            # 边听边写：用户能看见自己说的话，说错了当场就知道，不用等松手
            Insert-VoiceText -Text $text
            Set-BubbleHint '正在听… 松手出字'
        } else {
            Set-BubbleHint ("没听清（{0:P0}，门槛 {1:P0}）· 再说一遍" -f $conf, $minConf)
        }
        $h = $null
    }

    if ($pump.Rejected -and $script:Voice.Listening -and -not $script:Voice.Partial) {
        Set-BubbleHint '没听清 · 离麦克风近一点再说一遍'
    }

    # 收尾判定：宽限期到了就结束（不依赖 RecognizeCompleted，它在本机不来）
    if ($script:Voice.Stopping -and $script:Voice.StopDeadline -and (Get-Date) -gt $script:Voice.StopDeadline) {
        Complete-VoiceCapture
    }
}

function Complete-VoiceCapture {
    $wasListening = $script:Voice.Listening
    $commit = $script:Voice.CommitOnStop

    $script:Voice.Listening = $false
    $script:Voice.Stopping = $false
    $script:Voice.StopDeadline = $null
    $script:Voice.Partial = ''
    $script:Voice.Armed = $false

    if ($script:Voice.Pump) {
        # Cancel 放在 SetNull 前面：这一轮如果是被超时强制收尾的，
        # 引擎其实还停在异步识别状态，只解绑输入不解决 ——
        # 下一轮开麦会直接报「Cannot perform this operation while ... doing recognition」
        $script:Voice.Pump.CancelAsync()
        $script:Voice.Pump.SetNull()
    }
    Stop-VoicePoll

    $count = 0
    if ($null -ne $script:Voice.Segments) { $count = $script:Voice.Segments.Count }
    $script:Voice.Segments = $null

    Update-BubbleMicButton

    if (-not $wasListening) { return }

    if (-not $commit) {
        Undo-VoiceText
        Set-BubbleHint '已取消这一句'
        return
    }
    if ($count -eq 0) {
        Set-BubbleHint '没听清 · 按住热键再说一次'
        return
    }
    Set-BubbleHint "已输入 $count 句 · 回车发送"
}

function Reset-VoiceState {
    if ($script:Voice.Pump) {
        $script:Voice.Pump.CancelAsync()
        $script:Voice.Pump.SetNull()
    }
    Stop-VoicePoll
    $script:Voice.Listening = $false
    $script:Voice.Stopping = $false
    $script:Voice.Armed = $false
    $script:Voice.StopDeadline = $null
    $script:Voice.Partial = ''
    $script:Voice.Segments = $null
    $script:Voice.InsertFrom = -1
    $script:Voice.Inserted = 0
}

# ---------- 心跳定时器 ----------

function Get-VoiceHintSuffix {
    if (-not (Test-VoiceButtonVisible)) { return '' }
    $hk = [string]$script:Voice.Hotkey
    if (-not $hk) { return '' }
    return " · 按住 $hk 说话"
}

function Start-VoicePoll {
    if (-not $script:Voice.PollTimer) { return }
    if (-not $script:Voice.PollTimer.Enabled) { $script:Voice.PollTimer.Start() }
}

function Stop-VoicePoll {
    if ($script:Voice.PollTimer -and $script:Voice.PollTimer.Enabled) { $script:Voice.PollTimer.Stop() }
}

# 只在收音时跑。空闲时连定时器都停掉 —— 一个每秒查十几次的定时器
# 白白占着 UI 线程，而这个程序大部分时间是挂在托盘的。
function Initialize-VoiceTimer {
    if ($script:Voice.PollTimer) { return }

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 60
    $timer.Add_Tick({
        try {
            $script:Voice.Ticks++
            Update-VoiceInput

            # push-to-talk：松开就结束。RegisterHotKey 只给「按下」一次消息，
            # 没有抬起通知，所以这里补一个轻量轮询 —— 只在收音期间跑。
            if ($script:Voice.Listening -and $script:Voice.Armed -and -not (Test-VoiceHotkeyHeld)) {
                Stop-VoiceCapture -Commit $true
            }
        } catch {
            Write-CrashLog "语音心跳异常: $($_.Exception.Message)"
            try { Reset-VoiceState } catch { }
        }
    })
    $script:Voice.PollTimer = $timer
}

# ---------- 热键：按住说话 ----------

# 按顺序试，取第一个注册得上的 —— Ctrl+Alt+空格 常被输入法抢
$script:VoiceHotkeyCandidates = @(
    'ctrl+alt+space',
    'ctrl+shift+space',
    'ctrl+alt+v',
    'ctrl+shift+v'
)

function Register-HuanmengVoiceHotkey {
    if (-not $script:HotkeyWindow) { return @{ Ok = $false; Error = '热键窗口还没建好' } }

    if ($script:Voice.HotkeyOk) {
        try { [void][Huanmeng.Win32]::UnregisterHotKey($script:HotkeyWindow.Handle, $script:HK_VOICE) } catch { }
        $script:Voice.HotkeyOk = $false
    }

    $wanted = ''
    if ($script:Cfg -and $script:Cfg.speech) { $wanted = [string]$script:Cfg.speech.hotkey }

    $candidates = @()
    if ($wanted) { $candidates += $wanted }
    foreach ($c in $script:VoiceHotkeyCandidates) { if ($c -ne $wanted) { $candidates += $c } }

    foreach ($spec in $candidates) {
        $parsed = Convert-HotkeySpec -Spec $spec
        if ($null -eq $parsed) { continue }

        if ([Huanmeng.Win32]::RegisterHotKey($script:HotkeyWindow.Handle, $script:HK_VOICE, $parsed.Modifiers, $parsed.Vk)) {
            $script:Voice.Hotkey = $spec
            $script:Voice.HotkeyVk = $parsed.Vk
            $script:Voice.HotkeyMods = $parsed.Modifiers
            $script:Voice.HotkeyOk = $true

            # 配置里写的是被占用的那个，就改成实际生效的这个，
            # 免得用户下次打开偏好设置看到的是一个用不了的热键
            if ($wanted -and $spec -ne $wanted) {
                $script:Cfg.speech.hotkey = $spec
                try { Save-Config -Config $script:Cfg } catch { }
                if ($script:Notify) { & $script:Notify "$wanted 被占用了，语音热键改用 $spec" 'warn' }
            }
            return @{ Ok = $true; Error = ''; Hotkey = $spec }
        }
    }

    $script:Voice.Hotkey = ''
    $script:Voice.HotkeyOk = $false
    return @{ Ok = $false; Error = '候选的语音热键全被别的软件占用了，去偏好设置里自己指定一个' }
}

function Test-VoiceHotkeyHeld {
    if ($script:Voice.HotkeyVk -eq 0) { return $false }

    $mods = $script:Voice.HotkeyMods
    if (($mods -band 0x0002) -and -not ([Huanmeng.Win32]::GetAsyncKeyState($script:VK_CTRL) -band 0x8000)) { return $false }
    if (($mods -band 0x0001) -and -not ([Huanmeng.Win32]::GetAsyncKeyState($script:VK_ALT) -band 0x8000)) { return $false }
    if (($mods -band 0x0004) -and -not ([Huanmeng.Win32]::GetAsyncKeyState($script:VK_SHIFT) -band 0x8000)) { return $false }

    return ([Huanmeng.Win32]::GetAsyncKeyState($script:Voice.HotkeyVk) -band 0x8000) -ne 0
}

function Invoke-VoiceHotkeyDown {
    if ($script:Voice.Armed) { return }
    $script:Voice.Armed = $true
    if (-not (Start-VoiceCapture -Source 'hotkey')) {
        $script:Voice.Armed = $false
    }
}
