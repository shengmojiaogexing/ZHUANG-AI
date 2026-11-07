# ============================================================
#  Async.ps1 — 后台任务
#
#  出图一次要 10–60 秒，对话几秒到几十秒。这些在 UI 线程上跑的话，
#  托盘图标会变成「未响应」，圆环弹不出来，热键也失灵 —— 整个助手看起来像死了。
#
#  做法：
#    后台  → 独立 runspace 跑一段**自包含**的脚本块，结果塞进并发队列
#    主线程 → 定时器 Drain 队列，在主线程上执行回调
#
#  两条硬约束：
#    1. 后台脚本块里**拿不到主线程的任何变量**，所有输入必须从 $Arguments 传。
#       它只能靠自己 dot-source 的库文件（$script:AsyncLibs）干活。
#    2. 回调必须回到主线程才允许碰界面。WinForms 控件有线程亲和性，
#       从后台线程改控件属性会抛 InvalidOperationException，或者更糟 ——
#       静默地把界面搞坏。
# ============================================================

$script:AsyncQueue   = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
$script:AsyncPending = @{}
$script:AsyncLibs    = @()
$script:AsyncSeq     = 0

function Set-AsyncLibs {
    param([string[]]$Paths)
    $script:AsyncLibs = @($Paths)
}

function Start-AsyncTask {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Work,
        [hashtable]$Arguments = @{},
        [scriptblock]$OnDone = $null,
        # 任务进行中想回报进度就传它。后台调 Publish-AsyncProgress 即可，
        # 主线程会在定时器里收到。
        [scriptblock]$OnProgress = $null
    )

    $script:AsyncSeq += 1
    $id = $script:AsyncSeq

    $queue = $script:AsyncQueue
    $libs = $script:AsyncLibs

    $ps = [powershell]::Create()
    [void]$ps.AddScript({
        param($workText, $workArgs, $queueRef, $taskId, $libFiles)

        # 后台 runspace 是个干净的环境：没有主脚本的函数、没有 $script:Cfg。
        # 想用什么就自己 dot-source 进来。
        foreach ($lib in $libFiles) {
            try { . $lib } catch { }
        }

        # ---- 进度通道 ----
        # 后台任务（尤其是 agent）动不动跑几十秒，只回报最终结果的话，
        # 主线程那边全程只能显示「正在处理…」，用户会以为卡死了。
        # 这里给后台一个 Publish-AsyncProgress，进度记录和结果记录走同一条队列，
        # 用 kind 区分 —— 主线程看到 progress 就只回调、不当作任务结束。
        $global:AsyncProgressQueue = $queueRef
        $global:AsyncProgressId = $taskId
        function global:Publish-AsyncProgress {
            param([string]$Text)
            if (-not $global:AsyncProgressQueue) { return }
            if (-not $Text) { return }
            $global:AsyncProgressQueue.Enqueue(@{
                id = $global:AsyncProgressId; kind = 'progress'; text = [string]$Text
            })
        }

        $record = @{ id = $taskId; kind = 'done'; result = $null; error = $null }
        try {
            $work = [scriptblock]::Create($workText)
            $record.result = & $work @workArgs
        } catch {
            $record.error = $_.Exception.Message
        }
        $queueRef.Enqueue($record)
    })
    [void]$ps.AddArgument($Work.ToString())
    [void]$ps.AddArgument($Arguments)
    [void]$ps.AddArgument($queue)
    [void]$ps.AddArgument($id)
    [void]$ps.AddArgument($libs)

    $handle = $ps.BeginInvoke()
    $script:AsyncPending[$id] = @{ ps = $ps; handle = $handle; onDone = $OnDone; onProgress = $OnProgress }

    return $id
}

function Update-AsyncTasks {
    # 主线程的定时器调这个
    $record = $null
    while ($script:AsyncQueue.TryDequeue([ref]$record)) {
        if ($null -eq $record) { continue }

        # 进度记录：任务还在跑，**不能**把 pending 项删掉，也不能 EndInvoke
        if ($record.kind -eq 'progress') {
            $entryP = $script:AsyncPending[$record.id]
            if ($entryP -and $entryP.onProgress) {
                try { & $entryP.onProgress ([string]$record.text) } catch { }
            }
            continue
        }

        $entry = $script:AsyncPending[$record.id]
        if ($entry) {
            $script:AsyncPending.Remove($record.id)
            try {
                [void]$entry.ps.EndInvoke($entry.handle)
            } catch { }
            try { $entry.ps.Dispose() } catch { }
        }

        if ($record.error) {
            if ($script:Notify) { & $script:Notify "后台任务出错：$($record.error)" 'error' }
            continue
        }

        $callback = if ($entry) { $entry.onDone } else { $null }
        if ($callback) {
            try {
                & $callback $record.result
            } catch {
                if ($script:Notify) { & $script:Notify "处理结果时出错：$($_.Exception.Message)" 'error' }
            }
        }
    }
}

function Test-AsyncBusy {
    return ($script:AsyncPending.Count -gt 0)
}
