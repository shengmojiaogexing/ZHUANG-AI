/* ZHUANG-AI插件 · 本地数据
 * UI 偏好 / 自定义预设 / 历史记录 / 存储目录
 */
(function (root) {
    'use strict';

    var UI_KEY = 'zhuang_ai_ui_v1';
    var PRESET_KEY = 'zhuang_ai_presets_v1';
    var RING_SEED_KEY = 'zhuang_ai_ring_presets_seeded_v1';
    var HISTORY_KEY = 'zhuang_ai_history_v1';
    var HISTORY_LIMIT = 30;
    var memoryFolder = null;

    function readJson(key, fallback) {
        try {
            var raw = root.localStorage && root.localStorage.getItem(key);
            if (!raw) return fallback;
            var parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (error) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            root.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.warn('[store] 写入失败', key, error);
            return false;
        }
    }

    function uid(prefix) {
        return (prefix || 'zhuang') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }

    /* ---------------- UI 偏好 ---------------- */

    function readUi() {
        var value = readJson(UI_KEY, {});
        return {
            autoPlace: value.autoPlace !== false,
            autoColorMatch: value.autoColorMatch === true,
            imageCount: Math.max(1, Math.min(8, parseInt(value.imageCount, 10) || 1)),
            storageToken: String(value.storageToken || ''),
            storagePath: String(value.storagePath || ''),
            lastPresetId: String(value.lastPresetId || ''),
            draft: String(value.draft || ''),
            fontScale: Math.max(0.9, Math.min(1.5, Number(value.fontScale) || 1)),
            theme: ['white', 'gray', 'dark'].indexOf(value.theme) >= 0 ? value.theme : 'gray'
        };
    }

    function saveUi(patch) {
        var next = Object.assign(readUi(), patch || {});
        writeJson(UI_KEY, next);
        return next;
    }

    /* ---------------- 自定义预设 ---------------- */

    function normalizeCategory(value) {
        var category = String(value == null ? '' : value).trim();
        return category || '未分类';
    }

    function readCustomPresets() {
        var value = readJson(PRESET_KEY, []);
        return Array.isArray(value) ? value.filter(function (item) {
            return item && item.id && item.name && item.prompt;
        }).map(function (item) {
            return {
                id: String(item.id),
                name: String(item.name),
                prompt: String(item.prompt),
                category: normalizeCategory(item.category),
                createdAt: Number(item.createdAt) || 0
            };
        }) : [];
    }

    function writeCustomPresets(items) {
        writeJson(PRESET_KEY, items);
        return items;
    }

    /**
     * 第一次升级时把「幻梦圆环」自带的 68 条预设灌进来。
     * 灌进来之后就以插件这份为唯一数据源：圆环在线时读插件推过去的 state，
     * 两边看到的分类和名字完全一致；用户在插件里改，圆环也跟着变。
     */
    function ensureRingPresets() {
        if (readJson(RING_SEED_KEY, false) === true) return;
        var seed = Array.isArray(root.HUANMENG_RING_PRESETS) ? root.HUANMENG_RING_PRESETS : [];
        if (!seed.length) return;
        var existing = readCustomPresets();
        var seen = {};
        existing.forEach(function (item) {
            seen[normalizeCategory(item.category) + '|' + item.name] = true;
        });
        var merged = [];
        seed.forEach(function (item, index) {
            if (!item || !item.name || !item.prompt) return;
            var category = normalizeCategory(item.category);
            var key = category + '|' + item.name;
            if (seen[key]) return;
            seen[key] = true;
            merged.push({
                id: 'ring_' + String(index + 1).padStart(3, '0'),
                name: String(item.name),
                prompt: String(item.prompt),
                category: category,
                createdAt: 0
            });
        });
        merged = merged.concat(existing);
        writeCustomPresets(merged);
        writeJson(RING_SEED_KEY, true);
    }

    function presetIcon(category) {
        var text = String(category || '');
        if (text.indexOf('脸') > -1 || text.indexOf('人像') > -1 || text.indexOf('全身') > -1) return 'person';
        if (text.indexOf('发') > -1 || text.indexOf('毛') > -1) return 'brush';
        if (text.indexOf('背景') > -1) return 'mountain';
        if (text.indexOf('清晰') > -1 || text.indexOf('材质') > -1) return 'chip';
        if (text.indexOf('创意') > -1) return 'sparkle';
        return 'bookmark';
    }

    function allPresets() {
        ensureRingPresets();
        return readCustomPresets().map(function (item) {
            var category = normalizeCategory(item.category);
            return {
                id: item.id,
                name: item.name,
                desc: category,
                icon: presetIcon(category),
                prompt: item.prompt,
                category: category,
                builtIn: false
            };
        });
    }

    function findPreset(id) {
        var list = allPresets();
        for (var index = 0; index < list.length; index++) {
            if (list[index].id === id) return list[index];
        }
        return null;
    }

    function findPresetByName(name, category) {
        var wantedName = String(name || '');
        var wantedCategory = String(category || '');
        var list = allPresets();
        var index;
        if (wantedCategory) {
            for (index = 0; index < list.length; index++) {
                if (list[index].name === wantedName && list[index].category === wantedCategory) return list[index];
            }
        }
        for (index = 0; index < list.length; index++) {
            if (list[index].name === wantedName) return list[index];
        }
        return null;
    }

    function presetCategories() {
        var order = [];
        var counts = {};
        allPresets().forEach(function (preset) {
            var category = preset.category || '未分类';
            if (!counts[category]) {
                counts[category] = 0;
                order.push(category);
            }
            counts[category] += 1;
        });
        return order.map(function (category) {
            return { name: category, count: counts[category] };
        });
    }

    /** 圆环桥要的格式：[{category, items:[{name,prompt}]}] */
    function ringPresetGroups() {
        var groups = [];
        var index = {};
        allPresets().forEach(function (preset) {
            var category = preset.category || '未分类';
            if (!index[category]) {
                index[category] = { category: category, items: [] };
                groups.push(index[category]);
            }
            index[category].items.push({
                name: preset.name,
                prompt: preset.prompt
            });
        });
        return groups;
    }

    function addPreset(input) {
        var name = String(input && input.name || '').trim();
        var prompt = String(input && input.prompt || '').trim();
        var category = normalizeCategory(input && input.category);
        if (!name) throw new Error('给预设起个名字');
        if (!prompt) throw new Error('提示词不能为空');
        if (name.length > 20) throw new Error('名字最多 20 个字');
        if (prompt.length > 1000) throw new Error('提示词最多 1000 个字');
        var items = readCustomPresets();
        if (items.length >= 500) throw new Error('预设最多 500 个');
        var item = {
            id: uid('preset'),
            name: name,
            prompt: prompt,
            category: category,
            createdAt: Date.now()
        };
        items.unshift(item);
        writeCustomPresets(items);
        return item;
    }

    function updatePreset(id, input) {
        var items = readCustomPresets();
        for (var index = 0; index < items.length; index++) {
            if (items[index].id !== id) continue;
            var name = String(input && input.name || '').trim();
            var prompt = String(input && input.prompt || '').trim();
            if (!name) throw new Error('给预设起个名字');
            if (!prompt) throw new Error('提示词不能为空');
            items[index].name = name.slice(0, 20);
            items[index].prompt = prompt.slice(0, 1000);
            items[index].category = normalizeCategory(input && input.category);
            writeCustomPresets(items);
            return items[index];
        }
        throw new Error('预设不存在');
    }

    function removePreset(id) {
        var items = readCustomPresets().filter(function (item) { return item.id !== id; });
        writeCustomPresets(items);
        return true;
    }

    /* ---------------- 文件系统 ---------------- */

    function getUxp() {
        try {
            if (typeof require !== 'function') return null;
            var uxp = require('uxp');
            return uxp && uxp.storage ? uxp.storage : null;
        } catch (error) {
            return null;
        }
    }

    function hasUxpStorage() {
        var storage = getUxp();
        return !!(storage && storage.localFileSystem);
    }

    async function getFolderByName(name) {
        var storage = getUxp();
        if (!storage) throw new Error('当前环境不支持文件存储');
        var fs = storage.localFileSystem;
        var dataFolder = await fs.getDataFolder();
        try {
            return await dataFolder.getEntry(name);
        } catch (error) {
            return await dataFolder.createFolder(name);
        }
    }

    function dataUrlParts(dataUrl) {
        if (root.HuanmengCore && root.HuanmengCore.dataUrlToParts) {
            return root.HuanmengCore.dataUrlToParts(dataUrl);
        }
        var match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
        return match ? { mimeType: match[1].toLowerCase(), base64: match[2] } : null;
    }

    async function writeDataUrlToFolder(folder, fileName, dataUrl) {
        var parsed = dataUrlParts(dataUrl);
        if (!parsed) throw new Error('图片数据无效');
        var bytes = root.HuanmengCore
            ? root.HuanmengCore.base64ToUint8Array(parsed.base64)
            : Uint8Array.from(atob(parsed.base64), function (char) { return char.charCodeAt(0); });
        var file = await folder.createFile(fileName, { overwrite: true });
        var storage = getUxp();
        var binary = storage && storage.formats && storage.formats.binary;
        try {
            await file.write(bytes, binary ? { format: binary } : undefined);
        } catch (error) {
            await file.write(bytes);
        }
        return { file: file, mimeType: parsed.mimeType, bytes: bytes };
    }

    function extensionForMime(mimeType) {
        if (String(mimeType).indexOf('jpeg') > -1) return 'jpg';
        if (String(mimeType).indexOf('webp') > -1) return 'webp';
        return 'png';
    }

    /* ---------------- 存储目录 ---------------- */

    async function chooseStorageFolder() {
        var storage = getUxp();
        if (!storage) throw new Error('当前环境不支持选择文件夹');
        var fs = storage.localFileSystem;
        var folder = await fs.getFolder();
        if (!folder) return null;
        memoryFolder = folder;
        var token = '';
        try {
            token = await fs.createPersistentToken(folder);
        } catch (error) {
            console.warn('[store] 无法创建持久目录令牌', error);
        }
        var path = folder.nativePath || folder.name || '已选择文件夹';
        saveUi({ storageToken: token || '', storagePath: path });
        return { folder: folder, token: token || '', path: path };
    }

    async function resolveStorageFolder() {
        if (memoryFolder) return memoryFolder;
        var settings = readUi();
        if (!settings.storageToken) return null;
        var storage = getUxp();
        if (!storage) return null;
        try {
            var entry = await storage.localFileSystem.getEntryForPersistentToken(settings.storageToken);
            if (entry && entry.isFolder) {
                memoryFolder = entry;
                return entry;
            }
        } catch (error) {
            console.warn('[store] 存储目录令牌已失效', error);
        }
        return null;
    }

    async function saveImageToDirectory(dataUrl, baseName) {
        var folder = await resolveStorageFolder();
        if (!folder) {
            var error = new Error('还没有选择存储目录');
            error.code = 'NO_STORAGE_FOLDER';
            throw error;
        }
        var parsed = dataUrlParts(dataUrl);
        if (!parsed) throw new Error('图片数据无效');
        var stamp = new Date();
        var pad = function (value) { return String(value).padStart(2, '0'); };
        var name = (baseName || 'ZHUANG-AI') + '_' + stamp.getFullYear() + pad(stamp.getMonth() + 1) +
            pad(stamp.getDate()) + '_' + pad(stamp.getHours()) + pad(stamp.getMinutes()) +
            pad(stamp.getSeconds()) + '_' + Math.random().toString(36).slice(2, 5) + '.' +
            extensionForMime(parsed.mimeType);
        var result = await writeDataUrlToFolder(folder, name, dataUrl);
        return {
            file: result.file,
            name: name,
            path: folder.nativePath ? folder.nativePath + '\\' + name : name
        };
    }

    /* ---------------- 历史记录 ---------------- */

    function readHistory() {
        var value = readJson(HISTORY_KEY, []);
        return Array.isArray(value) ? value.filter(function (item) {
            return item && item.id;
        }) : [];
    }

    function writeHistory(items) {
        writeJson(HISTORY_KEY, items.slice(0, HISTORY_LIMIT));
        return items;
    }

    async function deleteHistoryFile(item) {
        if (!item || item.storage !== 'uxp' || !item.fileName) return;
        try {
            var folder = await getFolderByName('history');
            var file = await folder.getEntry(item.fileName);
            await file.delete();
        } catch (error) {
            console.warn('[store] 删除历史图片失败', error);
        }
    }

    async function pruneHistory(items) {
        var extra = items.slice(HISTORY_LIMIT);
        for (var index = 0; index < extra.length; index++) {
            await deleteHistoryFile(extra[index]);
        }
        return items.slice(0, HISTORY_LIMIT);
    }

    /**
     * 保存一条生成记录。
     * dataUrl 是原图；thumb 是显示用的缩略 data URL。
     */
    async function addHistory(entry, dataUrl, thumb) {
        var item = Object.assign({
            id: uid('history'),
            createdAt: Date.now(),
            prompt: '',
            presetName: '',
            model: '',
            modelName: '',
            resolution: '',
            placed: false,
            thumb: thumb || '',
            storage: 'none'
        }, entry || {});
        if (hasUxpStorage() && dataUrl) {
            try {
                var folder = await getFolderByName('history');
                var parsed = dataUrlParts(dataUrl);
                if (!parsed) throw new Error('图片数据无效');
                var fileName = item.id + '.' + extensionForMime(parsed.mimeType);
                await writeDataUrlToFolder(folder, fileName, dataUrl);
                item.fileName = fileName;
                item.mimeType = parsed.mimeType;
                item.storage = 'uxp';
            } catch (error) {
                console.warn('[store] 历史原图保存失败，仅保留缩略图', error);
            }
        }
        if (!item.thumb && item.storage !== 'uxp' && dataUrl) {
            item.thumb = dataUrl;
        }
        var items = readHistory();
        items.unshift(item);
        items = await pruneHistory(items);
        writeHistory(items);
        return item;
    }

    function historyList() {
        return readHistory().sort(function (left, right) {
            return Number(right.createdAt) - Number(left.createdAt);
        });
    }

    function findHistory(id) {
        var items = readHistory();
        for (var index = 0; index < items.length; index++) {
            if (items[index].id === id) return items[index];
        }
        return null;
    }

    async function readHistoryImage(item) {
        if (!item) return '';
        if (item.storage === 'uxp' && item.fileName && hasUxpStorage()) {
            try {
                var folder = await getFolderByName('history');
                var file = await folder.getEntry(item.fileName);
                var bytes = null;
                try {
                    var storage = getUxp();
                    var binary = storage && storage.formats && storage.formats.binary;
                    bytes = await file.read(binary ? { format: binary } : undefined);
                } catch (error) {
                    bytes = await file.read();
                }
                var base64 = root.HuanmengCore
                    ? root.HuanmengCore.uint8ArrayToBase64(bytes)
                    : btoa(String.fromCharCode.apply(null, bytes));
                return 'data:' + (item.mimeType || 'image/png') + ';base64,' + base64;
            } catch (error) {
                console.warn('[store] 读取历史原图失败', error);
            }
        }
        return item.thumb || '';
    }

    function updateHistory(id, patch) {
        var items = readHistory();
        for (var index = 0; index < items.length; index++) {
            if (items[index].id === id) {
                items[index] = Object.assign({}, items[index], patch || {});
                writeHistory(items);
                return items[index];
            }
        }
        return null;
    }

    async function removeHistory(id) {
        var items = readHistory();
        var next = [];
        for (var index = 0; index < items.length; index++) {
            if (items[index].id === id) await deleteHistoryFile(items[index]);
            else next.push(items[index]);
        }
        writeHistory(next);
        return true;
    }

    async function clearHistory() {
        var items = readHistory();
        for (var index = 0; index < items.length; index++) {
            await deleteHistoryFile(items[index]);
        }
        writeHistory([]);
        return items.length;
    }

    root.ZhuangStore = {
        readUi: readUi,
        saveUi: saveUi,
        readCustomPresets: readCustomPresets,
        allPresets: allPresets,
        findPreset: findPreset,
        findPresetByName: findPresetByName,
        presetCategories: presetCategories,
        ringPresetGroups: ringPresetGroups,
        addPreset: addPreset,
        updatePreset: updatePreset,
        removePreset: removePreset,
        hasUxpStorage: hasUxpStorage,
        chooseStorageFolder: chooseStorageFolder,
        resolveStorageFolder: resolveStorageFolder,
        saveImageToDirectory: saveImageToDirectory,
        addHistory: addHistory,
        historyList: historyList,
        findHistory: findHistory,
        readHistoryImage: readHistoryImage,
        updateHistory: updateHistory,
        removeHistory: removeHistory,
        clearHistory: clearHistory
    };
})(window);
