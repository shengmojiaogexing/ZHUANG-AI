/* ZHUANG-AI插件 · 预览图
 * UXP 对大图 data URL 的解码不稳定，所以聊天区和历史只显示缩略图。
 * 原图始终完整保留，用于回贴和保存。
 */
(function (root) {
    'use strict';

    function createCanvas(width, height) {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        return canvas;
    }

    function canvasToDataUrl(canvas) {
        try {
            var jpeg = canvas.toDataURL('image/jpeg', 0.84);
            if (jpeg && jpeg.indexOf('data:image/') === 0) return jpeg;
        } catch (error) {
            console.warn('[preview] JPEG 导出失败', error);
        }
        try {
            var png = canvas.toDataURL('image/png');
            if (png && png.indexOf('data:image/') === 0) return png;
        } catch (error) {
            console.warn('[preview] PNG 导出失败', error);
        }
        return '';
    }

    /**
     * data URL → 小尺寸 JPEG data URL。
     * 失败返回空字符串，由上层改用 Photoshop 像素抓取。
     */
    function thumbnailFromDataUrl(dataUrl, maxDimension) {
        return new Promise(function (resolve) {
            if (!dataUrl) {
                resolve('');
                return;
            }
            var image = new Image();
            var settled = false;
            var timer = setTimeout(function () {
                finish('');
            }, 8000);

            function finish(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                image.onload = null;
                image.onerror = null;
                resolve(value || '');
            }

            image.onload = function () {
                try {
                    var width = Number(image.naturalWidth || image.width) || 0;
                    var height = Number(image.naturalHeight || image.height) || 0;
                    if (!width || !height) {
                        finish('');
                        return;
                    }
                    var limit = Math.max(160, Number(maxDimension) || 720);
                    var scale = Math.min(1, limit / Math.max(width, height));
                    var targetWidth = Math.max(1, Math.round(width * scale));
                    var targetHeight = Math.max(1, Math.round(height * scale));
                    var canvas = createCanvas(targetWidth, targetHeight);
                    var context = canvas.getContext('2d');
                    if (!context) {
                        finish('');
                        return;
                    }
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, targetWidth, targetHeight);
                    context.drawImage(image, 0, 0, targetWidth, targetHeight);
                    finish(canvasToDataUrl(canvas));
                } catch (error) {
                    console.warn('[preview] 生成缩略图失败', error);
                    finish('');
                }
            };
            image.onerror = function () { finish(''); };
            try {
                image.src = dataUrl;
            } catch (error) {
                finish('');
            }
        });
    }

    /**
     * 从 Photoshop 的 RGBA 像素生成缩略图。
     * 这条路径不经过 new Image()，大图回贴后作为可靠兜底。
     */
    function thumbnailFromRgba(imageData, maxDimension) {
        try {
            if (!imageData || !imageData.data || !imageData.width || !imageData.height) return '';
            var width = Number(imageData.width);
            var height = Number(imageData.height);
            var limit = Math.max(160, Number(maxDimension) || 720);
            var scale = Math.min(1, limit / Math.max(width, height));
            var targetWidth = Math.max(1, Math.round(width * scale));
            var targetHeight = Math.max(1, Math.round(height * scale));
            var canvas = createCanvas(targetWidth, targetHeight);
            var context = canvas.getContext('2d');
            if (!context) return '';
            var source = imageData.data;
            if (targetWidth === width && targetHeight === height) {
                var pixels = context.createImageData(width, height);
                pixels.data.set(source);
                context.putImageData(pixels, 0, 0);
            } else {
                var full = createCanvas(width, height);
                var fullContext = full.getContext('2d');
                if (!fullContext) return '';
                var fullPixels = fullContext.createImageData(width, height);
                fullPixels.data.set(source);
                fullContext.putImageData(fullPixels, 0, 0);
                context.drawImage(full, 0, 0, targetWidth, targetHeight);
            }
            return canvasToDataUrl(canvas);
        } catch (error) {
            console.warn('[preview] RGBA 缩略图失败', error);
            return '';
        }
    }

    root.ZhuangImageTools = {
        thumbnailFromDataUrl: thumbnailFromDataUrl,
        thumbnailFromRgba: thumbnailFromRgba
    };
})(window);
