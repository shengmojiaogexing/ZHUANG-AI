/**
 * 幻梦AI · ComfyUI 工作流格式转换
 *
 * 把 ComfyUI 里保存的**界面格式**工作流转成 **API 格式**。
 *
 * 【为什么需要它】
 * ComfyUI 的工作流浏览器（以及它在磁盘上存的文件）用的是「界面格式」：
 * 带 nodes / links / widgets_values，是给画布渲染用的。
 * 而 /prompt 接口只认「API 格式」：{ "节点号": { class_type, inputs } }。
 * 两者完全不同，直接喂过去 ComfyUI 只会说参数不对。
 *
 * ComfyUI 自己是在浏览器里做这个转换的（点 Queue 的那一刻），服务端没有这个接口。
 * 所以插件要自己实现 —— 这就是本文件。
 *
 * 【实测数据（ComfyUI 0.37.0，用户本机 3 份工作流）】
 *   节点：  { id, type, mode, inputs[], outputs[], widgets_values[],
 *            widgets_values_named{}, title?, properties{} }
 *   连线：  links[] 每条是 [linkId, 源节点, 源输出槽, 目标节点, 目标输入槽, 类型]
 *   输入：  node.inputs[i] = { name, type, link: 连线号|null, widget: {name} }
 *
 * 【两条关键实测结论】
 *   1) widgets_values_named 是 { 参数名: 值 } 的字典，**不用去猜位置**。
 *      实测：没有它的节点，恰好就是**没有任何可编辑参数**的节点
 *      （VAEDecode / InvertMask 这类只有连线的）。所以有它就用它，干净可靠。
 *   2) PrimitiveNode（虚拟节点）看着要特殊处理，其实不用 ——
 *      它连到目标节点的某个 widget 输入上，而目标节点自己的
 *      widgets_values_named 里已经存着同一个值。按「有值就用值」处理自然就对。
 */
(function () {
    'use strict';

    // 纯界面用的节点：画布上存在，但不参与执行
    const UI_ONLY_NODES = ['Note', 'MarkdownNote', 'PreviewAny', 'PreviewImage'];
    // 直通节点：一进一出，转换时要把它「穿过」
    const PASSTHROUGH_NODES = ['Reroute', 'RerouteNode'];

    // 节点模式。实测用户的 image_qwen_image_2_1_image_edit.json 里有 7 个 mode=4，
    // 其中一个是没选 lora 的 LoraLoader —— 不处理旁路的话，它会被当成正常节点发出去，
    // ComfyUI 回一句「lora_name: None not in []」，看起来像缺模型，其实是转换没做对。
    const MODE_ALWAYS = 0;
    const MODE_MUTED = 2;
    const MODE_BYPASS = 4;

    function isUiFormat(value) {
        return !!value && typeof value === 'object' && Array.isArray(value.nodes);
    }

    function isApiFormat(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (value.nodes || value.links) return false;
        const keys = Object.keys(value);
        if (keys.length === 0) return false;
        return keys.some(function (key) {
            const node = value[key];
            return node && typeof node === 'object' && typeof node.class_type === 'string';
        });
    }

    /**
     * 从节点标题里解析出「#NN 说明」标记。
     *
     * 这是 SD-PPP 那套约定：工作流作者给要暴露给用户的参数起名
     * `#01 正向提示词`、`#02 反向提示词`……数字决定它们显示的顺序。
     * 节点属性里的 sdppp_widgetable_title 是同一个串的镜像，但我们只认标题 ——
     * 因为转换后只有标题会进 _meta，属性不会，认一个来源就不会两边打架。
     *
     * 实测：节点号是 622/623/638/646/643，而 # 号是 01~05 —— 顺序完全对不上，
     * 所以必须按解析出来的数字排，不能按节点号排。
     */
    function parseMarker(title) {
        if (!title) return null;
        const matched = /#\s*(\d+)\s*(.*)/.exec(String(title));
        if (!matched) return null;
        const num = parseInt(matched[1], 10);
        if (Number.isNaN(num)) return null;
        return { num: num, label: String(matched[2] || '').trim() };
    }

    /**
     * 取出下拉框的可选项。不是下拉就返回 null。
     *
     * 两种写法都要认，少认一种就会静默丢控件：
     *   老：["euler", "dpmpp_2m", ...]        —— 类型本身就是数组
     *   新：["COMBO", { options: [...] }]     —— 实测本机 0.37.0 有 516 处 / 283 个节点用这个，
     *                                            比老写法（65 处）还多
     * 新写法漏掉过一次：`"COMBO"` 掉进兜底分支被当成「连线」，
     * 于是大部分下拉框在界面上直接消失，还不报错。
     */
    function comboChoicesOf(spec) {
        if (spec == null) return null;
        const type = Array.isArray(spec) ? spec[0] : spec;
        const options = (Array.isArray(spec) && spec[1] && typeof spec[1] === 'object') ? spec[1] : {};

        let raw = null;
        if (Array.isArray(type)) raw = type;
        else if (type === 'COMBO' && Array.isArray(options.options)) raw = options.options;
        if (!Array.isArray(raw)) return null;

        return raw.map(function (choice) {
            return String(Array.isArray(choice) ? choice[0] : choice);
        });
    }

    /** 这个 spec 是不是可编辑控件（而不是连线） */
    function isWidgetSpec(spec) {
        if (spec == null) return false;
        const type = Array.isArray(spec) ? spec[0] : spec;
        if (Array.isArray(type)) return true;                 // COMBO
        if (typeof type !== 'string') return false;
        if (type === 'INT' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN' || type === 'COMBO') return true;
        // V3 的动态类型在画布上也是控件，但值我们拿不到，交给下面单独处理
        return type.indexOf('COMFY_') === 0;
    }

    /** 节点定义里所有可编辑参数的顺序（按 required 再 optional，各按定义顺序） */
    function widgetOrderOf(definition) {
        const order = [];
        if (!definition || !definition.input) return order;
        ['required', 'optional'].forEach(function (section) {
            const block = definition.input[section];
            if (!block || typeof block !== 'object') return;
            Object.keys(block).forEach(function (name) {
                if (isWidgetSpec(block[name])) order.push(name);
            });
        });
        return order;
    }

    /**
     * 主函数。
     *
     * @param {Object} uiWorkflow 界面格式工作流（ComfyUI 存的 JSON）
     * @param {Object} objectInfo ComfyUI /object_info 的返回
     * @returns {{ok:boolean, api:Object|null, problems:Array, stats:Object}}
     *   problems[].level: 'block' 转不了 | 'warn' 转了但可能不对
     */
    function toApi(uiWorkflow, objectInfo) {
        const problems = [];
        const stats = { nodeTotal: 0, nodeConverted: 0, nodeSkipped: 0, linkResolved: 0, widgetFilled: 0, markerCount: 0 };
        // 标记参数表：键是「节点号::参数名」，正好和面板里参数 key 的格式一致，
        // 面板可以拿 key 直接查，不用再套一层映射
        const markers = {};

        if (!isUiFormat(uiWorkflow)) {
            problems.push({ level: 'block', message: '这份 JSON 里没有 nodes 数组，不像是 ComfyUI 的界面格式工作流。' });
            return { ok: false, api: null, markers: markers, problems: problems, stats: stats };
        }
        if (!objectInfo || typeof objectInfo !== 'object') {
            problems.push({ level: 'block', message: '拿不到 ComfyUI 的节点定义，没法做转换。' });
            return { ok: false, api: null, markers: markers, problems: problems, stats: stats };
        }

        function addMarker(nodeId, inputName, marker) {
            if (nodeId == null || !inputName || !marker) return;
            const key = String(nodeId) + '::' + inputName;
            if (markers[key]) return;   // 同一个参数被标两次，保留先遇到的
            markers[key] = marker;
            stats.markerCount++;
        }

        const nodes = Array.isArray(uiWorkflow.nodes) ? uiWorkflow.nodes : [];
        stats.nodeTotal = nodes.length;

        // ---- 索引：连线号 → 来源
        const linkMap = {};
        const links = Array.isArray(uiWorkflow.links) ? uiWorkflow.links : [];
        links.forEach(function (entry) {
            if (!Array.isArray(entry) || entry.length < 5) return;
            // 目标端也要记：标记参数时要把虚拟节点上的 # 接力到它连着的那个输入上
            linkMap[entry[0]] = {
                originId: entry[1], originSlot: entry[2],
                targetId: entry[3], targetSlot: entry[4]
            };
        });

        const nodeById = {};
        nodes.forEach(function (node) {
            if (node && node.id != null) nodeById[node.id] = node;
        });

        /**
         * 顺着连线找到真正的来源。
         *
         * 两种情况要「穿过」来源节点（它自己不产出东西，只是把线接过去）：
         *   · Reroute —— 直通节点，API 格式里压根不存在
         *   · 旁路节点（mode=4）—— 用户把节点关掉了，ComfyUI 会把它的输出
         *     按「类型相同的输入」接过去。比如旁路的 LoraLoader：
         *     输出 MODEL ← 输入 model，输出 CLIP ← 输入 clip。
         *     不穿过去的话，下游会连到一个根本不会执行的节点号上。
         *
         * PrimitiveNode 不用穿：它的值目标节点自己的 widgets_values_named 里也有一份。
         */
        function resolveSource(linkId, depth) {
            const hop = linkMap[linkId];
            if (!hop) return null;
            const originNode = nodeById[hop.originId];
            if (!originNode) return null;
            if (depth > 16) return null; // 环，防死循环

            const originType = typeof originNode.type === 'string' ? originNode.type : '';

            if (PASSTHROUGH_NODES.indexOf(originType) >= 0) {
                const upstream = (originNode.inputs || []).find(function (input) {
                    return input && input.link != null;
                });
                if (!upstream) return null;
                return resolveSource(upstream.link, depth + 1);
            }

            if (originNode.mode === MODE_BYPASS) {
                const outputs = originNode.outputs || [];
                const outSlot = outputs[hop.originSlot];
                const outType = outSlot && outSlot.type;
                // 按类型找对应的输入。ComfyUI 前端就是这么配的。
                const fed = (originNode.inputs || []).find(function (input) {
                    return input && input.link != null && input.type === outType;
                });
                // 找不到对应输入 → 这条线确实断了（旁路掉的 LoadImage 就是这种：
                // 它没有输入，所以输出也就没有了）。交给上面报「悬空连线」。
                if (!fed) return null;
                return resolveSource(fed.link, depth + 1);
            }

            return { nodeId: hop.originId, slot: hop.originSlot, classType: originType };
        }

        // ---- 逐个节点转换
        const api = {};
        const apiIds = {};

        nodes.forEach(function (node) {
            if (!node || node.id == null) return;
            const classType = node.type;
            const label = classType + ' (#' + node.id + ')';

            if (typeof classType !== 'string') return;

            // 纯界面节点：画布上的备注之类，直接丢掉
            if (UI_ONLY_NODES.indexOf(classType) >= 0) {
                stats.nodeSkipped++;
                return;
            }
            // 静音（muted）的节点不参与执行。下游连到它的线会被下面的
            // 「悬空连线」检查断掉并告警 —— 这正是 ComfyUI 里的表现。
            if (node.mode === MODE_MUTED) {
                stats.nodeSkipped++;
                return;
            }
            // 旁路（bypassed）的节点不执行，但它的**输出会被接过去** ——
            // 具体在 resolveSource 里做，这里不能把它写进 API 图。
            if (node.mode === MODE_BYPASS) {
                stats.nodeSkipped++;
                return;
            }
            // 直通节点在 API 格式里不存在，跳过（它的下游会通过 resolveSource 穿透过来）
            if (PASSTHROUGH_NODES.indexOf(classType) >= 0) {
                stats.nodeSkipped++;
                return;
            }
            // PrimitiveNode：值已经存在目标节点的 widgets_values_named 里，不用它出场。
            //
            // 但它的 **# 标记不能跟着丢**。实测用户的 `#03 宽高比` 就挂在这种虚拟节点上，
            // 直接跳过的话，那个标记会消失在转换里，面板就少一个标记参数 ——
            // 用户只会看到「作者标了 5 个，界面里只有 4 个」。
            // 所以要把标记**接力到它连着的那个输入**上。
            if (classType === 'PrimitiveNode') {
                const primMarker = parseMarker(node.title);
                if (primMarker) {
                    (node.outputs || []).forEach(function (output) {
                        (output.links || []).forEach(function (linkId) {
                            const hop = linkMap[linkId];
                            if (!hop) return;
                            const targetNode = nodeById[hop.targetId];
                            if (!targetNode) return;
                            const targetInput = (targetNode.inputs || [])[hop.targetSlot];
                            if (targetInput && targetInput.name) {
                                addMarker(hop.targetId, targetInput.name, primMarker);
                            }
                        });
                    });
                }
                stats.nodeSkipped++;
                return;
            }

            const definition = objectInfo[classType];
            if (!definition) {
                // object_info 里没有 = 本机没有这个节点。
                // 两种可能：新版前端的「子图」（type 是一串 UUID），或者缺自定义节点。
                const looksLikeSubgraph = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(classType);
                problems.push({
                    level: 'block',
                    nodeId: node.id,
                    classType: classType,
                    message: looksLikeSubgraph
                        ? label + ' 是一个「子图」，插件暂时不支持。请在 ComfyUI 里右键子图 → 展开（或直接导出 API 格式）再用。'
                        : label + ' 这个节点类型本机 ComfyUI 没有 —— 多半是缺自定义节点。请先在 ComfyUI 里把它跑通。'
                });
                return;
            }

            const named = (node.widgets_values_named && typeof node.widgets_values_named === 'object')
                ? node.widgets_values_named : null;
            const inputDef = definition.input || {};
            // 画布上这个节点声明的输入（含连线号和 widget 名）
            const declared = {};
            (node.inputs || []).forEach(function (input) {
                if (input && input.name) declared[input.name] = input;
            });

            const inputs = {};
            const widgetOrder = widgetOrderOf(definition);
            // 位置兜底：给没有 widgets_values_named 的老文件用
            const positional = Array.isArray(node.widgets_values) ? node.widgets_values : null;
            let cursor = 0;

            widgetOrder.forEach(function (name) {
                let spec = null;
                ['required', 'optional'].forEach(function (section) {
                    const block = inputDef[section];
                    if (spec === null && block && Object.prototype.hasOwnProperty.call(block, name)) {
                        spec = block[name];
                    }
                });
                if (spec === null) return;

                const specOptions = Array.isArray(spec) && spec[1] && typeof spec[1] === 'object' ? spec[1] : {};
                const isComboLike = Array.isArray(spec) ? Array.isArray(spec[0]) : false;

                // 值优先从 widgets_values_named 取
                let value;
                let hasValue = false;
                if (named && Object.prototype.hasOwnProperty.call(named, name)) {
                    value = named[name];
                    hasValue = true;
                } else if (positional && cursor < positional.length) {
                    value = positional[cursor];
                    hasValue = true;
                }

                // 种子后面那个「生成后控制」在界面上是独立控件，
                // 位置上会多占一格。不跳过它，后面所有参数都会错位一格。
                if (specOptions.control_after_generate === true && positional && !named) {
                    cursor += 2;
                } else if (positional && !named) {
                    cursor += 1;
                }

                // V3 动态类型：选项运行时才算，值我们看不懂，跳过让 ComfyUI 用自己的默认值
                if (!isComboLike && typeof (Array.isArray(spec) ? spec[0] : spec) === 'string'
                    && String(Array.isArray(spec) ? spec[0] : spec).indexOf('COMFY_') === 0) {
                    return;
                }

                if (hasValue && value !== undefined) {
                    inputs[name] = value;
                    stats.widgetFilled++;
                }
            });

            // 连线型输入
            Object.keys(declared).forEach(function (name) {
                const input = declared[name];
                if (input.link == null) return;
                // 已经被 widget 值填过的，说明它是 widget 输入（比如挂在 PrimitiveNode 上），
                // 不要再用连线覆盖
                if (Object.prototype.hasOwnProperty.call(inputs, name)) return;

                const source = resolveSource(input.link, 0);
                if (!source) {
                    problems.push({
                        level: 'warn',
                        nodeId: node.id,
                        classType: classType,
                        message: label + ' 的输入「' + name + '」指向一个找不到的来源，已跳过。'
                    });
                    return;
                }
                inputs[name] = [String(source.nodeId), source.slot];
                stats.linkResolved++;
            });

            // ---- 动态下拉（COMFY_DYNAMICCOMBO_V3）：父参数要补上，子参数**保持扁平**
            //
            // ⚠️ 这两条都是真机 POST /prompt 实测出来的，别再凭直觉改：
            //
            //   ① 父参数 = 选中那一项的**名字**（一个字符串），不是字典。
            //      它的类型是 COMFY_DYNAMICCOMBO_V3，上面按 widgetOrder 走的那一圈
            //      因为 `COMFY_` 前缀把它整段跳过了（见上面那个 return），
            //      所以这里必须补。缺了父参数，子参数就成了孤零零一个 `父.子` 键，
            //      Python 报「execute() got an unexpected keyword argument 'resize_type.multiplier'」。
            //
            //   ② 子参数的键名就是「父.子」，**平级平铺**，绝不能收成嵌套对象。
            //      曾经「修」成嵌套，结果换了另一种报错 ——
            //        ResizeImageMaskNode.execute() missing 1 required positional argument: 'resize_type'
            //      原因在 ComfyUI 侧：comfy_api/latest/_io.py 的 DynamicCombo._expand_schema_for_dynamic
            //      是拿 `live_inputs[父]` 当**选项名字符串**去 options 里查表的
            //      （`for option in options: if option["key"] == key`）。父参数一旦是字典，
            //      一条都匹配不上 → 这个输入连同子参数被整个丢掉 → 报「参数缺失」。
            //      查表命中后，子参数靠 v3_data.dynamic_paths 拼回嵌套结构交给节点，不用我们拼。
            //
            // 三种写法对着真 ComfyUI 跑过（tools/probe-resize-shape.mjs）：
            //     扁平  "resize_type": "scale by multiplier" + "resize_type.multiplier": 4   → 成功
            //     嵌套  "resize_type": {resize_type: ..., multiplier: 4}                       → 报参数缺失
            //     两种都给                                                                     → 同样报错（字典把正确的挤掉了）
            // 子参数是**连线**时同样成立（probe-resize-link.mjs，换成 Primitive 驱动的画质参数也成功）。
            Object.keys(inputDef.required || {}).concat(Object.keys(inputDef.optional || {})).forEach(function (name) {
                const spec = (inputDef.required && Object.prototype.hasOwnProperty.call(inputDef.required, name))
                    ? inputDef.required[name]
                    : (inputDef.optional || {})[name];
                const type = Array.isArray(spec) ? spec[0] : spec;
                if (type !== 'COMFY_DYNAMICCOMBO_V3') return;

                // ① 父参数：把「选了哪一项」补进去
                if (!Object.prototype.hasOwnProperty.call(inputs, name)
                    && named && Object.prototype.hasOwnProperty.call(named, name)) {
                    inputs[name] = named[name];
                    stats.widgetFilled++;
                }

                // ② 子参数：补**纯控件**的那些（连线型的已由上面的连线循环填好，不覆盖）。
                // 子参数名不是 object_info 的顶层键，按 widgetOrder 走的那一圈扫不到它们，
                // 不补的话这些子参数会静默丢失 —— 节点拿到默认值，出的图跟用户设的不一样。
                if (named) {
                    Object.keys(named).forEach(function (key) {
                        if (key.indexOf(name + '.') !== 0) return;
                        if (Object.prototype.hasOwnProperty.call(inputs, key)) return; // 连线优先
                        inputs[key] = named[key];
                        stats.widgetFilled++;
                    });
                }
            });

            const apiId = String(node.id);
            apiIds[apiId] = true;
            api[apiId] = { class_type: classType, inputs: inputs };
            if (node.title && String(node.title).trim()) {
                api[apiId]._meta = { title: String(node.title).trim() };
            }

            // 作者用 # 标了这个节点 → 它所有**能编辑的**参数都算标记参数。
            // 连线不算（那不是一个能填的值，标它没意义）。
            const nodeMarker = parseMarker(node.title);
            if (nodeMarker) {
                Object.keys(inputs).forEach(function (name) {
                    if (Array.isArray(inputs[name])) return;
                    addMarker(node.id, name, nodeMarker);
                });
            }

            stats.nodeConverted++;
        });

        // ---- 预检：下拉型的值，本机 ComfyUI 里到底有没有
        //
        // 这一步把「跑起来才报错」变成「转换完就告诉你」。
        // 实测最常见的两种：工作流里选了个本机没装的模型（ckpt_name / lora_name），
        // 或者那个下拉压根没选（值是 null）—— 后者的报错原文是
        // 「lora_name: None not in []」，看着像缺模型，其实是什么都没选。
        Object.keys(api).forEach(function (id) {
            const node = api[id];
            const definition = objectInfo[node.class_type];
            if (!definition || !definition.input) return;

            Object.keys(node.inputs).forEach(function (name) {
                const value = node.inputs[name];
                if (value !== null && typeof value !== 'string') return;

                let spec = null;
                ['required', 'optional'].forEach(function (section) {
                    const block = definition.input[section];
                    if (spec === null && block && Object.prototype.hasOwnProperty.call(block, name)) {
                        spec = block[name];
                    }
                });
                if (spec == null) return;

                const choices = comboChoicesOf(spec);
                if (!choices) return; // 不是下拉，不管

                if (value === null || value === '') {
                    // 空着但选项里有空串的，说明「不选」是合法的，不告警
                    if (choices.indexOf('') >= 0) return;
                    problems.push({
                        level: 'warn',
                        nodeId: id,
                        classType: node.class_type,
                        message: '#' + id + '（' + node.class_type + '）的「' + name + '」没有选任何值。'
                            + '这个参数是必填的，请先在 ComfyUI 里选一个。'
                    });
                    return;
                }

                if (choices.indexOf(value) < 0) {
                    problems.push({
                        level: 'warn',
                        nodeId: id,
                        classType: node.class_type,
                        message: '#' + id + '（' + node.class_type + '）的「' + name + '」填的是「' + value
                            + '」，但本机 ComfyUI 里没有这一项（可用 ' + choices.length + ' 个）。'
                            + '多半是缺模型文件，请先在 ComfyUI 里把它选成一个存在的。'
                    });
                }
            });
        });

        // ---- 收尾检查：连线不能指向不存在的节点
        // 这一步能挡掉「Reroute 没穿透干净」「静音节点还被引用」这类问题 ——
        // 否则 ComfyUI 会回一句很含糊的校验错误，用户完全不知道从哪查。
        Object.keys(api).forEach(function (id) {
            const inputs = api[id].inputs;
            Object.keys(inputs).forEach(function (name) {
                const value = inputs[name];
                if (!Array.isArray(value) || value.length !== 2) return;
                if (!apiIds[value[0]]) {
                    delete inputs[name];
                    problems.push({
                        level: 'warn',
                        nodeId: id,
                        classType: api[id].class_type,
                        message: '#' + id + ' 的「' + name + '」连到了一个被跳过或不存在的节点（#' + value[0] + '），已断开。'
                    });
                }
            });
        });

        if (Object.keys(api).length === 0) {
            problems.push({ level: 'block', message: '转换后一个节点都不剩，这份工作流没法执行。' });
        }

        const hasBlock = problems.some(function (item) { return item.level === 'block'; });
        return {
            ok: !hasBlock,
            api: hasBlock ? null : api,
            markers: markers,
            problems: problems,
            stats: stats
        };
    }

    /**
     * 从**已经是 API 格式**的工作流里抽标记。
     * 用户手动导入的 API 文件走这条路（没有界面格式可转，但 _meta.title 里
     * 一样可能带着作者写的 # 标记）。
     */
    function markersFromApi(api) {
        const markers = {};
        Object.keys(api || {}).forEach(function (id) {
            const node = api[id];
            if (!node || typeof node !== 'object') return;
            const marker = parseMarker(node._meta && node._meta.title);
            if (!marker) return;
            Object.keys(node.inputs || {}).forEach(function (name) {
                if (Array.isArray(node.inputs[name])) return;
                markers[id + '::' + name] = marker;
            });
        });
        return markers;
    }

    /** 把 problems 汇总成一段给用户看的话 */
    function summarizeProblems(problems) {
        const list = Array.isArray(problems) ? problems : [];
        if (list.length === 0) return '';
        const blocking = list.filter(function (item) { return item.level === 'block'; });
        const warns = list.filter(function (item) { return item.level === 'warn'; });
        const lines = [];
        if (blocking.length > 0) {
            lines.push('这份工作流转不了：');
            blocking.slice(0, 5).forEach(function (item) { lines.push('· ' + item.message); });
            if (blocking.length > 5) lines.push('· …还有 ' + (blocking.length - 5) + ' 个');
        }
        if (warns.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push('有 ' + warns.length + ' 处需要注意（已跳过）：');
            warns.slice(0, 5).forEach(function (item) { lines.push('· ' + item.message); });
            if (warns.length > 5) lines.push('· …还有 ' + (warns.length - 5) + ' 个');
        }
        return lines.join('\n');
    }

    window.HuanmengComfyConvert = {
        isUiFormat: isUiFormat,
        isApiFormat: isApiFormat,
        isWidgetSpec: isWidgetSpec,
        comboChoicesOf: comboChoicesOf,
        widgetOrderOf: widgetOrderOf,
        parseMarker: parseMarker,
        markersFromApi: markersFromApi,
        toApi: toApi,
        summarizeProblems: summarizeProblems
    };
})();
