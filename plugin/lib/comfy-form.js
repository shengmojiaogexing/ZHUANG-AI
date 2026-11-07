/**
 * 幻梦AI · ComfyUI 动态表单引擎
 *
 * 职责：把「一份 API 格式的工作流」+「ComfyUI 的节点定义」合成一张参数界面说明书。
 * 不碰 DOM —— 它只产出数据结构，由 comfy-panel.js 负责画出来。
 * 这样引擎可以脱离界面单独测试。
 *
 * ============================ 判型规则 ============================
 * 全部来自对 ComfyUI 0.37.0 本机 /object_info 的实测（972 个节点）。
 *
 * 节点定义长这样：
 *   node.input.required[名字] = [类型, 选项对象?]
 *   node.input.optional[名字] = 同上
 *   node.input.hidden[名字]   = 同上（ComfyUI 自己填，绝不能碰）
 *
 * 类型的三种形态：
 *   1. 字符串 'INT' / 'FLOAT' / 'STRING' / 'BOOLEAN'  → 可编辑控件
 *   2. 字符串 其它（MODEL/CLIP/VAE/LATENT/IMAGE/CONDITIONING/MASK…）→ 连线，跳过
 *   3. 数组 ['euler','dpmpp_2m',…] → 下拉框
 *
 * ⚠️ 两个实测确认的形态，都必须处理：
 *   a) spec 有两种形态：数组 [类型, 选项]，或**裸字符串**「类型」。
 *      实测（ComfyUI 0.37.0 / 972 节点）分段统计：裸字符串只出现在 hidden 段，
 *      共 24 个（例如 SaveImage.prompt = "PROMPT"），required/optional 里是 0 个。
 *      hidden 本来就不渲染，所以这里的作用是防御：万一日后版本把裸字符串挪进
 *      required，按 spec[0] 取类型会取到首字母（'P' 而不是 'PROMPT'），
 *      白名单匹配不上，参数会静默消失 —— 这种 bug 极难查，不如一开始就兼容。
 *   b) object_info 里有一批 V3 新类型：实测 166 个节点带
 *      COMFY_DYNAMICCOMBO_V3 / COMFY_AUTOGROW_V3，选项是运行时动态算的，
 *      静态渲染不了。它们要显式登记为「跳过并说明原因」，
 *      否则用户会以为插件漏了参数，转而怀疑是插件坏了。
 */
(function () {
    'use strict';

    // 能直接渲染成控件的原始类型
    const EDITABLE_SCALARS = {
        INT: { kind: 'int', label: '整数' },
        FLOAT: { kind: 'float', label: '小数' },
        STRING: { kind: 'string', label: '文本' },
        BOOLEAN: { kind: 'bool', label: '开关' }
    };

    // 明确知道渲染不了、且要给出人话解释的类型
    const UNSUPPORTED_REASONS = {
        COMFY_DYNAMICCOMBO_V3: '选项由 ComfyUI 在运行时动态决定，插件里改不了',
        COMFY_AUTOGROW_V3: '这是可变长输入，请在 ComfyUI 里配置',
        COMFY_MULTITYPE_INPUT_V3: '这是多类型输入，请在 ComfyUI 里配置'
    };

    /**
     * 把节点定义里的一条 spec 归一化成 { type, options }。
     * 同时吃掉上面说的「裸字符串」坑。
     */
    function normalizeSpec(spec) {
        if (Array.isArray(spec)) {
            return { type: spec[0], options: spec[1] && typeof spec[1] === 'object' ? spec[1] : {} };
        }
        if (typeof spec === 'string') {
            // 兜底分支：实测只出现在 hidden 段，但留着——见文件头的说明
            return { type: spec, options: {} };
        }
        return null;
    }

    /**
     * 判断一个 spec 该渲染成什么。
     * 返回 { kind, ... } ；kind 为 'link' 表示这是连线，'unsupported' 表示渲染不了。
     */
    function classifySpec(spec) {
        const normalized = normalizeSpec(spec);
        if (!normalized) return { kind: 'unsupported', reason: '节点定义格式无法识别' };

        const type = normalized.type;
        const options = normalized.options;

        if (Array.isArray(type)) {
            // 老写法：选项直接就是类型本身，["euler", "dpmpp_2m", ...]
            const choices = type.map(function (item) {
                // 有些选项是 [显示名, 值] 的对子，取显示名
                if (Array.isArray(item)) return String(item[0]);
                return String(item);
            });
            return { kind: 'combo', choices: choices, options: options };
        }

        if (typeof type === 'string') {
            // 新写法：类型是字符串 "COMBO"，选项在 spec[1].options 里。
            //
            // ⚠️ 这条分支曾经漏掉，代价很大：实测本机 0.37.0 有 **516 处 / 283 个节点**
            // 用这个形态，比老写法（65 处）还多得多。漏了它，`"COMBO"` 会掉进下面
            // 兜底的 link 分支 —— 于是**大部分下拉框被当成连线静默跳过**，
            // 界面上看不到，也不报错。
            // （发现过程：作者标的 `#03 宽高比` 绑在 ResolutionSelector 上，
            //   界面上就是不出这一项，顺藤摸瓜才查到。）
            if (type === 'COMBO') {
                if (options.multiselect === true) {
                    // 多选下拉的值是数组，普通 <select> 表达不了。
                    // 与其渲染一个会产生错值的控件，不如明确说一声。
                    return { kind: 'unsupported', reason: '这是多选下拉框，插件里改不了（请在 ComfyUI 里选）', type: type };
                }
                if (!Array.isArray(options.options)) {
                    // 选项由 ComfyUI 运行时才算（实测 LoadImageOutput.image 就是这种）
                    return { kind: 'unsupported', reason: '这个下拉的选项由 ComfyUI 动态生成，插件里改不了', type: type };
                }
                return {
                    kind: 'combo',
                    choices: options.options.map(function (item) {
                        return String(Array.isArray(item) ? item[0] : item);
                    }),
                    options: options
                };
            }

            const scalar = EDITABLE_SCALARS[type];
            if (scalar) {
                return {
                    kind: scalar.kind,
                    options: options,
                    min: options.min,
                    max: options.max,
                    step: options.step,
                    multiline: options.multiline === true,
                    // 带这个标记的是随机种子，界面上给个「随机」按钮
                    isSeed: options.control_after_generate === true
                };
            }
            if (UNSUPPORTED_REASONS[type]) {
                return { kind: 'unsupported', reason: UNSUPPORTED_REASONS[type], type: type };
            }
            // 剩下的都是连线类型：MODEL / CLIP / IMAGE / LATENT / CONDITIONING…
            return { kind: 'link', type: type };
        }

        return { kind: 'unsupported', reason: '节点定义格式无法识别' };
    }

    /**
     * 判断工作流里某个 input 的值是不是连线。
     *
     * API 格式里连线一律是 [节点号, 输出序号]，节点号是**字符串**。
     * 只判 Array.isArray 不够稳：万一将来出现别的数组形态会被误判成连线，
     * 参数就莫名其妙不见了，所以额外校验一下形状。
     */
    function isLinkValue(value) {
        if (!Array.isArray(value)) return false;
        if (value.length !== 2) return false;
        const nodeId = value[0];
        return (typeof nodeId === 'string' || typeof nodeId === 'number')
            && typeof value[1] === 'number';
    }

    /**
     * 从工作流节点上取一个好认的标题。
     * API 格式会带 _meta.title（就是 ComfyUI 界面上那个自定义标题），
     * 没有就退回节点类型名。
     */
    function readNodeTitle(node, classType) {
        const meta = node && node._meta;
        if (meta && typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim();
        return classType;
    }

    /**
     * 主函数：产出参数模型。
     *
     * @param {Object} objectInfo  ComfyUI /object_info 的返回
     * @param {Object} workflow    API 格式工作流
     * @returns {{nodes: Array, skipped: Array, stats: Object}}
     *   nodes[].params[] 每项：
     *     { key, name, kind, value, choices?, min?, max?, step?, multiline?, isSeed?, tooltip? }
     *   key 形如 "12::steps"，用来回写数值。
     */
    function buildParamModel(objectInfo, workflow, options) {
        const opts = options || {};
        // 「#NN 说明」标记表，键是「节点号::参数名」，来自 comfy-convert
        const markerMap = opts.markers && typeof opts.markers === 'object' ? opts.markers : {};
        const nodes = [];
        const skipped = [];
        let paramCount = 0;
        let markedCount = 0;

        if (!objectInfo || typeof objectInfo !== 'object') {
            return { nodes: [], skipped: [], marked: [], stats: { nodeCount: 0, paramCount: 0, skippedCount: 0, markedCount: 0 } };
        }
        if (!workflow || typeof workflow !== 'object') {
            return { nodes: [], skipped: [], marked: [], stats: { nodeCount: 0, paramCount: 0, skippedCount: 0, markedCount: 0 } };
        }

        // 按节点号数字序排，避免出现 "10" 排在 "2" 前面这种别扭顺序
        const nodeIds = Object.keys(workflow).filter(function (id) {
            const node = workflow[id];
            return node && typeof node === 'object' && !Array.isArray(node);
        }).sort(function (a, b) {
            const na = parseInt(a, 10);
            const nb = parseInt(b, 10);
            if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
            return na - nb;
        });

        nodeIds.forEach(function (nodeId) {
            const node = workflow[nodeId];
            const classType = String(node.class_type || '');
            const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : null;
            if (!inputs) return;

            const definition = objectInfo[classType];
            if (!definition) {
                // 工作流里用到、但本机 ComfyUI 上没有这个节点 —— 几乎肯定是缺自定义节点。
                // 这条必须告诉用户，否则他只会看到「参数少了」。
                skipped.push({
                    nodeId: nodeId,
                    classType: classType,
                    name: '*',
                    reason: '本机 ComfyUI 没有这个节点（' + classType + '），很可能缺自定义节点。请先在 ComfyUI 里把工作流跑通。'
                });
                return;
            }

            const inputDef = definition.input || {};
            const title = readNodeTitle(node, classType);
            const params = [];

            Object.keys(inputs).forEach(function (inputName) {
                const value = inputs[inputName];

                if (isLinkValue(value)) return; // 连线，归工作流图管，不做输入框

                // 定义可能在 required，也可能在 optional
                let spec = null;
                let section = '';
                if (inputDef.required && Object.prototype.hasOwnProperty.call(inputDef.required, inputName)) {
                    spec = inputDef.required[inputName];
                    section = 'required';
                } else if (inputDef.optional && Object.prototype.hasOwnProperty.call(inputDef.optional, inputName)) {
                    spec = inputDef.optional[inputName];
                    section = 'optional';
                }

                if (spec === null) {
                    // 找不到定义：可能是 hidden 字段，也可能是自定义节点没申明。
                    // hidden 是 ComfyUI 自己填的，静默跳过才是对的；
                    // 其余情况记一笔，方便排查。
                    const hidden = inputDef.hidden || {};
                    if (!Object.prototype.hasOwnProperty.call(hidden, inputName)) {
                        skipped.push({
                            nodeId: nodeId,
                            classType: classType,
                            name: inputName,
                            reason: '在节点定义里找不到这个参数的说明，已跳过'
                        });
                    }
                    return;
                }

                const classified = classifySpec(spec);
                if (classified.kind === 'link') return; // 连线，同上
                if (classified.kind === 'unsupported') {
                    skipped.push({
                        nodeId: nodeId,
                        classType: classType,
                        name: inputName,
                        reason: classified.reason || '类型不支持'
                    });
                    return;
                }

                const optionBlock = classified.options || {};
                const paramKey = nodeId + '::' + inputName;
                const marker = markerMap[paramKey] || null;
                if (marker) markedCount++;
                params.push({
                    key: paramKey,
                    nodeId: nodeId,
                    name: inputName,
                    section: section,
                    kind: classified.kind,
                    value: value,
                    choices: classified.choices,
                    min: classified.min,
                    max: classified.max,
                    step: classified.step,
                    multiline: classified.multiline === true,
                    isSeed: classified.isSeed === true,
                    marker: marker,
                    tooltip: typeof optionBlock.tooltip === 'string' ? optionBlock.tooltip : ''
                });
                paramCount++;
            });

            if (params.length > 0) {
                nodes.push({ id: nodeId, classType: classType, title: title, params: params });
            }
        });

        // 标记参数单独整理一份，由这里排好序。
        //
        // ⚠️ 必须按解析出来的 **# 号** 排，不能按节点号 ——
        // 实测用户那份工作流：节点号 622/623/638/646/643，而 # 号是 01~05，
        // 两者的顺序完全对不上。按节点号排会得到 04 在 05 前面这种结果。
        const marked = [];
        nodes.forEach(function (node) {
            node.params.forEach(function (param) {
                if (!param.marker) return;
                marked.push({
                    num: param.marker.num,
                    label: param.marker.label,
                    param: param,
                    node: node
                });
            });
        });
        marked.sort(function (a, b) {
            if (a.num !== b.num) return a.num - b.num;
            // 同号（作者写重了）时按参数 key 兜底，保证顺序稳定不跳
            return String(a.param.key).localeCompare(String(b.param.key));
        });

        // 「只显示标记参数」。
        // 但**没有标记的工作流不能因此变成空界面** —— 作者没标 # 是常态，
        // 那种情况照常把所有参数显示出来，否则用户面对一份工作流什么都改不了。
        const markedOnly = opts.markedOnly === true && marked.length > 0;

        return {
            nodes: nodes,
            skipped: skipped,
            marked: marked,
            markedOnly: markedOnly,
            stats: {
                nodeCount: nodes.length,
                paramCount: paramCount,
                skippedCount: skipped.length,
                markedCount: markedCount
            }
        };
    }

    /**
     * 把界面上的值写回工作流，返回一个**新的**工作流对象。
     * 不改原件：出图失败时用户还想拿原来那份重试。
     *
     * values 形如 { "12::steps": 30, "6::text": "一只猫" }
     */
    function applyParamValues(workflow, values) {
        if (!workflow || typeof workflow !== 'object') return workflow;
        const patch = values || {};
        const clone = JSON.parse(JSON.stringify(workflow));

        Object.keys(patch).forEach(function (key) {
            const parts = String(key).split('::');
            if (parts.length !== 2) return;
            const nodeId = parts[0];
            const inputName = parts[1];
            const node = clone[nodeId];
            if (!node || !node.inputs) return;

            const spec = node.inputs[inputName];
            if (isLinkValue(spec)) return; // 绝不覆盖连线，否则整张图会断

            node.inputs[inputName] = patch[key];
        });

        return clone;
    }

    /**
     * 按控件类型把界面上的字符串转成工作流要的类型。
     * 数字框里拿到的是字符串，直接塞进工作流会让 ComfyUI 报类型错。
     */
    function coerceValue(kind, raw) {
        if (kind === 'int') {
            const parsed = parseInt(raw, 10);
            return Number.isNaN(parsed) ? 0 : parsed;
        }
        if (kind === 'float') {
            const parsed = parseFloat(raw);
            return Number.isNaN(parsed) ? 0 : parsed;
        }
        if (kind === 'bool') return raw === true || raw === 'true';
        return String(raw == null ? '' : raw);
    }

    /**
     * 生成一个随机种子。
     * 上限用 2^32-1 而不是 object_info 里那个 18446744073709551615 ——
     * 后者超过 JS 的安全整数范围，算出来的数会悄悄丢精度。
     */
    function randomSeed() {
        return Math.floor(Math.random() * 4294967296);
    }

    /**
     * 导入时做一次基本校验，明确区分「API 格式」和「界面格式」。
     * 这是新手最容易踩的坑：在 ComfyUI 里直接 Ctrl+S 导出的是界面格式，
     * 长得像 JSON 但结构完全不同，塞进去只会得到莫名其妙的报错。
     */
    function validateWorkflowShape(parsed) {
        if (Array.isArray(parsed)) {
            return { ok: false, reason: '这份 JSON 最外层是数组，看起来是 ComfyUI 的**界面格式**（而是不是 API 格式）。\n'
                + '请在 ComfyUI 里用「工作流 → 导出（API 格式）」重新导出。' };
        }
        if (!parsed || typeof parsed !== 'object') {
            return { ok: false, reason: '这份 JSON 不是一个对象，无法当作工作流使用。' };
        }
        const keys = Object.keys(parsed);
        if (keys.length === 0) return { ok: false, reason: '工作流是空的。' };

        // 界面格式有 nodes / links 这两个顶层字段，特征很明显
        if (parsed.nodes || parsed.links) {
            return { ok: false, reason: '这份 JSON 里有 nodes / links 字段，是 ComfyUI 的**界面格式**。\n'
                + '请在 ComfyUI 里用「工作流 → 导出（API 格式）」重新导出。' };
        }

        const looksLikeApi = keys.some(function (key) {
            const node = parsed[key];
            return node && typeof node === 'object' && typeof node.class_type === 'string';
        });
        if (!looksLikeApi) {
            return { ok: false, reason: '这份 JSON 里找不到任何带 class_type 的节点，不像是 ComfyUI 的 API 格式工作流。' };
        }
        return { ok: true, reason: '' };
    }

    window.HuanmengComfyForm = {
        buildParamModel: buildParamModel,
        applyParamValues: applyParamValues,
        validateWorkflowShape: validateWorkflowShape,
        classifySpec: classifySpec,
        isLinkValue: isLinkValue,
        coerceValue: coerceValue,
        randomSeed: randomSeed
    };
})();
