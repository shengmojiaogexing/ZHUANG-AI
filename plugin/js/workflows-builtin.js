/* ZHUANG-AI插件 · 内置 ComfyUI 工作流
 * 来源：本机 ComfyUI user/default/workflows，原样导出后做了最小可用性补丁：
 *   · 主图 LoadImage 标题加 #06 标记，清掉 SDPPP 遗留临时图片名，配合「读取选区」使用；
 *   · 文生图补 #01 提示词 / #02 LoRA / #03 画幅标记；
 *   · 清理指向已删除 / 旁路节点的悬空输入连线；
 *   · 清空工作流里自带的固定提示词（提示词由插件面板填写）。
 */
(function (root) {
    'use strict';
    root.ZHUANG_BUILTIN_WORKFLOWS = {
 "version": 2,
 "defaultId": "image-edit",
 "source": "ComfyUI user/default/workflows（本机导出，按插件参数标记做了最小补丁）",
 "items": [
  {
   "id": "image-edit",
   "name": "内置 · 图生图带放大（默认）",
   "badge": "默认",
   "sourceFile": "image_qwen_image_2_1_image_edit.json",
   "description": "本机 ComfyUI 的图生图带放大工作流；主图节点已标成 #06，点「读取选区」可直接上传 Photoshop 选区。；已清空固定提示词",
   "patched": true,
   "data": {
    "id": "54bb395d-3e60-4c94-b525-85523901575b",
    "revision": 0,
    "last_node_id": 646,
    "last_link_id": 964,
    "nodes": [
     {
      "id": 478,
      "type": "CLIPLoader",
      "pos": [
       -910,
       2850
      ],
      "size": [
       510,
       120
      ],
      "flags": {},
      "order": 0,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "CLIP名称",
        "name": "clip_name",
        "type": "COMBO",
        "widget": {
         "name": "clip_name"
        },
        "link": null
       },
       {
        "localized_name": "类型",
        "name": "type",
        "type": "COMBO",
        "widget": {
         "name": "type"
        },
        "link": null
       },
       {
        "localized_name": "设备",
        "name": "device",
        "shape": 7,
        "type": "COMBO",
        "widget": {
         "name": "device"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "CLIP",
        "name": "CLIP",
        "type": "CLIP",
        "links": [
         749
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "CLIPLoader",
       "models": [
        {
         "name": "qwen3vl_8b_int8_convrot.safetensors",
         "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
         "directory": "text_encoders"
        }
       ]
      },
      "widgets_values": [
       "qwen3vl_8b_int8_convrot.safetensors",
       "qwen_image",
       "default"
      ],
      "widgets_values_named": {
       "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
       "type": "qwen_image",
       "device": "default"
      }
     },
     {
      "id": 479,
      "type": "VAELoader",
      "pos": [
       -910,
       3050
      ],
      "size": [
       510,
       70
      ],
      "flags": {},
      "order": 1,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "vae名称",
        "name": "vae_name",
        "type": "COMBO",
        "widget": {
         "name": "vae_name"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "VAE",
        "name": "VAE",
        "type": "VAE",
        "links": [
         731,
         745
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAELoader",
       "models": [
        {
         "name": "qwen_image_2.1_vae_bf16.safetensors",
         "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
         "directory": "vae"
        }
       ]
      },
      "widgets_values": [
       "qwen_image_2.1_vae_bf16.safetensors"
      ],
      "widgets_values_named": {
       "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
      }
     },
     {
      "id": 477,
      "type": "UNETLoader",
      "pos": [
       -910,
       2690
      ],
      "size": [
       510,
       90
      ],
      "flags": {},
      "order": 2,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "UNet名称",
        "name": "unet_name",
        "type": "COMBO",
        "widget": {
         "name": "unet_name"
        },
        "link": null
       },
       {
        "localized_name": "数据类型",
        "name": "weight_dtype",
        "type": "COMBO",
        "widget": {
         "name": "weight_dtype"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         747
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "UNETLoader",
       "models": [
        {
         "name": "qwen_image_2.1_int8_convrot.safetensors",
         "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
         "directory": "diffusion_models"
        }
       ]
      },
      "widgets_values": [
       "qwen_image_2.1_int8_convrot.safetensors",
       "default"
      ],
      "widgets_values_named": {
       "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
       "weight_dtype": "default"
      }
     },
     {
      "id": 13,
      "type": "ResolutionSelector",
      "pos": [
       360,
       2660
      ],
      "size": [
       300,
       190
      ],
      "flags": {},
      "order": 19,
      "mode": 0,
      "showAdvanced": true,
      "inputs": [
       {
        "localized_name": "宽高比",
        "name": "aspect_ratio",
        "type": "COMBO",
        "widget": {
         "name": "aspect_ratio"
        },
        "link": 958
       },
       {
        "localized_name": "百万像素",
        "name": "megapixels",
        "type": "FLOAT",
        "widget": {
         "name": "megapixels"
        },
        "link": null
       },
       {
        "localized_name": "倍数",
        "name": "multiple",
        "type": "INT",
        "widget": {
         "name": "multiple"
        },
        "link": null
       },
       {
        "localized_name": "预览",
        "name": "preview",
        "shape": 7,
        "type": "RESOLUTION_PREVIEW",
        "widget": {
         "name": "preview"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "宽度",
        "name": "width",
        "type": "INT",
        "links": [
         741
        ]
       },
       {
        "localized_name": "高度",
        "name": "height",
        "type": "INT",
        "links": [
         742
        ]
       }
      ],
      "title": "主流程分辨率选择器",
      "properties": {
       "Node name for S&R": "ResolutionSelector"
      },
      "widgets_values": [
       "1:1 (Square)",
       1.5,
       32
      ],
      "widgets_values_named": {
       "aspect_ratio": "1:1 (Square)",
       "megapixels": 1.5,
       "multiple": 32
      }
     },
     {
      "id": 480,
      "type": "EmptyLatentImage",
      "pos": [
       370,
       2900
      ],
      "size": [
       300,
       120
      ],
      "flags": {},
      "order": 22,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "宽度",
        "name": "width",
        "type": "INT",
        "widget": {
         "name": "width"
        },
        "link": 741
       },
       {
        "localized_name": "高度",
        "name": "height",
        "type": "INT",
        "widget": {
         "name": "height"
        },
        "link": 742
       },
       {
        "localized_name": "批量大小",
        "name": "batch_size",
        "type": "INT",
        "widget": {
         "name": "batch_size"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         735
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "EmptyLatentImage"
      },
      "widgets_values": [
       1024,
       1024,
       1
      ],
      "widgets_values_named": {
       "width": 1024,
       "height": 1024,
       "batch_size": 1
      }
     },
     {
      "id": 484,
      "type": "QwenImage21Cache",
      "pos": [
       380,
       3090
      ],
      "size": [
       270,
       120
      ],
      "flags": {},
      "order": 20,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "model",
        "name": "model",
        "type": "MODEL",
        "link": 748
       },
       {
        "localized_name": "device",
        "name": "device",
        "type": "COMBO",
        "widget": {
         "name": "device"
        },
        "link": null
       },
       {
        "localized_name": "dtype",
        "name": "dtype",
        "type": "COMBO",
        "widget": {
         "name": "dtype"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         737
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "QwenImage21Cache"
      },
      "widgets_values": [
       "auto",
       "default"
      ],
      "widgets_values_named": {
       "device": "auto",
       "dtype": "default"
      }
     },
     {
      "id": 483,
      "type": "ComfySwitchNode",
      "pos": [
       380,
       3270
      ],
      "size": [
       270,
       110
      ],
      "flags": {},
      "order": 23,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "为假时",
        "name": "on_false",
        "shape": 7,
        "type": "LATENT",
        "link": 740
       },
       {
        "localized_name": "为真时",
        "name": "on_true",
        "shape": 7,
        "type": "LATENT",
        "link": 735
       },
       {
        "localized_name": "切换",
        "name": "switch",
        "type": "BOOLEAN",
        "widget": {
         "name": "switch"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "输出",
        "name": "output",
        "type": "LATENT",
        "links": [
         734
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "ComfySwitchNode"
      },
      "widgets_values": [
       false
      ],
      "widgets_values_named": {
       "switch": false
      }
     },
     {
      "id": 482,
      "type": "KSampler",
      "pos": [
       700,
       2790
      ],
      "size": [
       270,
       270
      ],
      "flags": {},
      "order": 24,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "模型",
        "name": "model",
        "type": "MODEL",
        "link": 737
       },
       {
        "localized_name": "正面条件",
        "name": "positive",
        "type": "CONDITIONING",
        "link": 738
       },
       {
        "localized_name": "负面条件",
        "name": "negative",
        "type": "CONDITIONING",
        "link": 739
       },
       {
        "localized_name": "Latent图像",
        "name": "latent_image",
        "type": "LATENT",
        "link": 734
       },
       {
        "localized_name": "种子",
        "name": "seed",
        "type": "INT",
        "widget": {
         "name": "seed"
        },
        "link": null
       },
       {
        "localized_name": "步数",
        "name": "steps",
        "type": "INT",
        "widget": {
         "name": "steps"
        },
        "link": 964
       },
       {
        "localized_name": "cfg",
        "name": "cfg",
        "type": "FLOAT",
        "widget": {
         "name": "cfg"
        },
        "link": null
       },
       {
        "localized_name": "采样器名称",
        "name": "sampler_name",
        "type": "COMBO",
        "widget": {
         "name": "sampler_name"
        },
        "link": null
       },
       {
        "localized_name": "调度器",
        "name": "scheduler",
        "type": "COMBO",
        "widget": {
         "name": "scheduler"
        },
        "link": null
       },
       {
        "localized_name": "降噪",
        "name": "denoise",
        "type": "FLOAT",
        "widget": {
         "name": "denoise"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         733
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "KSampler"
      },
      "widgets_values": [
       118758214241555,
       "randomize",
       25,
       1,
       "euler",
       "simple",
       1
      ],
      "widgets_values_named": {
       "seed": 118758214241555,
       "control_after_generate": "randomize",
       "steps": 25,
       "cfg": 1,
       "sampler_name": "euler",
       "scheduler": "simple",
       "denoise": 1
      }
     },
     {
      "id": 567,
      "type": "VAELoader",
      "pos": [
       1040,
       2820
      ],
      "size": [
       270,
       80
      ],
      "flags": {},
      "order": 3,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "vae名称",
        "name": "vae_name",
        "type": "COMBO",
        "widget": {
         "name": "vae_name"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "VAE",
        "name": "VAE",
        "type": "VAE",
        "links": [
         877,
         883
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAELoader",
       "cnr_id": "comfy-core",
       "ver": "0.27.0",
       "models": [
        {
         "name": "seedvr2_ema_vae_fp16.safetensors",
         "url": "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors",
         "directory": "vae"
        }
       ]
      },
      "widgets_values": [
       "seedvr2_ema_vae_fp16.safetensors"
      ],
      "widgets_values_named": {
       "vae_name": "seedvr2_ema_vae_fp16.safetensors"
      }
     },
     {
      "id": 568,
      "type": "UNETLoader",
      "pos": [
       1040,
       2650
      ],
      "size": [
       270,
       110
      ],
      "flags": {},
      "order": 4,
      "mode": 0,
      "showAdvanced": false,
      "inputs": [
       {
        "localized_name": "UNet名称",
        "name": "unet_name",
        "type": "COMBO",
        "widget": {
         "name": "unet_name"
        },
        "link": null
       },
       {
        "localized_name": "数据类型",
        "name": "weight_dtype",
        "type": "COMBO",
        "widget": {
         "name": "weight_dtype"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         874,
         878
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "UNETLoader",
       "cnr_id": "comfy-core",
       "ver": "0.27.0",
       "models": [
        {
         "name": "seedvr2_7b_int8_convrot.safetensors",
         "url": "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors",
         "directory": "diffusion_models"
        }
       ]
      },
      "widgets_values": [
       "seedvr2_7b_int8_convrot.safetensors",
       "default"
      ],
      "widgets_values_named": {
       "unet_name": "seedvr2_7b_int8_convrot.safetensors",
       "weight_dtype": "default"
      }
     },
     {
      "id": 569,
      "type": "SeedVR2Preprocess",
      "pos": [
       1030,
       3290
      ],
      "size": [
       270,
       60
      ],
      "flags": {},
      "order": 28,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "resized_images",
        "name": "resized_images",
        "type": "IMAGE",
        "link": 873
       }
      ],
      "outputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "links": [
         876
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "SeedVR2Preprocess",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      }
     },
     {
      "id": 570,
      "type": "SeedVR2Conditioning",
      "pos": [
       1400,
       2620
      ],
      "size": [
       270,
       80
      ],
      "flags": {},
      "order": 30,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "model",
        "name": "model",
        "type": "MODEL",
        "link": 874
       },
       {
        "label": "latent",
        "localized_name": "vae_conditioning",
        "name": "vae_conditioning",
        "type": "LATENT",
        "link": 875
       }
      ],
      "outputs": [
       {
        "localized_name": "positive",
        "name": "positive",
        "type": "CONDITIONING",
        "links": [
         879
        ]
       },
       {
        "localized_name": "negative",
        "name": "negative",
        "type": "CONDITIONING",
        "links": [
         880
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "SeedVR2Conditioning",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      }
     },
     {
      "id": 571,
      "type": "VAEEncodeTiled",
      "pos": [
       1400,
       2760
      ],
      "size": [
       270,
       230
      ],
      "flags": {},
      "order": 29,
      "mode": 0,
      "showAdvanced": true,
      "inputs": [
       {
        "localized_name": "像素",
        "name": "pixels",
        "type": "IMAGE",
        "link": 876
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "type": "VAE",
        "link": 877
       },
       {
        "localized_name": "分块尺寸",
        "name": "tile_size",
        "type": "INT",
        "widget": {
         "name": "tile_size"
        },
        "link": null
       },
       {
        "localized_name": "重叠",
        "name": "overlap",
        "type": "INT",
        "widget": {
         "name": "overlap"
        },
        "link": null
       },
       {
        "localized_name": "时间尺寸",
        "name": "temporal_size",
        "type": "INT",
        "widget": {
         "name": "temporal_size"
        },
        "link": null
       },
       {
        "localized_name": "时间重叠",
        "name": "temporal_overlap",
        "type": "INT",
        "widget": {
         "name": "temporal_overlap"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         875,
         881
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAEEncodeTiled",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       512,
       128,
       4096,
       8
      ],
      "widgets_values_named": {
       "tile_size": 512,
       "overlap": 128,
       "temporal_size": 4096,
       "temporal_overlap": 8
      }
     },
     {
      "id": 572,
      "type": "KSampler",
      "pos": [
       1380,
       3040
      ],
      "size": [
       270,
       320
      ],
      "flags": {},
      "order": 31,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "模型",
        "name": "model",
        "type": "MODEL",
        "link": 878
       },
       {
        "localized_name": "正面条件",
        "name": "positive",
        "type": "CONDITIONING",
        "link": 879
       },
       {
        "localized_name": "负面条件",
        "name": "negative",
        "type": "CONDITIONING",
        "link": 880
       },
       {
        "localized_name": "Latent图像",
        "name": "latent_image",
        "type": "LATENT",
        "link": 881
       },
       {
        "localized_name": "种子",
        "name": "seed",
        "type": "INT",
        "widget": {
         "name": "seed"
        },
        "link": null
       },
       {
        "localized_name": "步数",
        "name": "steps",
        "type": "INT",
        "widget": {
         "name": "steps"
        },
        "link": null
       },
       {
        "localized_name": "cfg",
        "name": "cfg",
        "type": "FLOAT",
        "widget": {
         "name": "cfg"
        },
        "link": null
       },
       {
        "localized_name": "采样器名称",
        "name": "sampler_name",
        "type": "COMBO",
        "widget": {
         "name": "sampler_name"
        },
        "link": null
       },
       {
        "localized_name": "调度器",
        "name": "scheduler",
        "type": "COMBO",
        "widget": {
         "name": "scheduler"
        },
        "link": null
       },
       {
        "localized_name": "降噪",
        "name": "denoise",
        "type": "FLOAT",
        "widget": {
         "name": "denoise"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         882
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "KSampler",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       959948902156062,
       "fixed",
       1,
       1,
       "euler",
       "simple",
       1
      ],
      "widgets_values_named": {
       "seed": 959948902156062,
       "control_after_generate": "fixed",
       "steps": 1,
       "cfg": 1,
       "sampler_name": "euler",
       "scheduler": "simple",
       "denoise": 1
      }
     },
     {
      "id": 573,
      "type": "VAEDecodeTiled",
      "pos": [
       1740,
       2630
      ],
      "size": [
       270,
       230
      ],
      "flags": {},
      "order": 32,
      "mode": 0,
      "showAdvanced": true,
      "inputs": [
       {
        "localized_name": "Latent",
        "name": "samples",
        "type": "LATENT",
        "link": 882
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "type": "VAE",
        "link": 883
       },
       {
        "localized_name": "分块尺寸",
        "name": "tile_size",
        "type": "INT",
        "widget": {
         "name": "tile_size"
        },
        "link": null
       },
       {
        "localized_name": "重叠",
        "name": "overlap",
        "type": "INT",
        "widget": {
         "name": "overlap"
        },
        "link": null
       },
       {
        "localized_name": "时间尺寸",
        "name": "temporal_size",
        "type": "INT",
        "widget": {
         "name": "temporal_size"
        },
        "link": null
       },
       {
        "localized_name": "时间重叠",
        "name": "temporal_overlap",
        "type": "INT",
        "widget": {
         "name": "temporal_overlap"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         884
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAEDecodeTiled",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       512,
       128,
       4096,
       8
      ],
      "widgets_values_named": {
       "tile_size": 512,
       "overlap": 128,
       "temporal_size": 4096,
       "temporal_overlap": 8
      }
     },
     {
      "id": 575,
      "type": "ResizeImageMaskNode",
      "pos": [
       1030,
       3090
      ],
      "size": [
       270,
       118
      ],
      "flags": {},
      "order": 27,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "输入",
        "name": "input",
        "type": "IMAGE,MASK",
        "link": 886
       },
       {
        "localized_name": "调整类型",
        "name": "resize_type",
        "type": "COMFY_DYNAMICCOMBO_V3",
        "widget": {
         "name": "resize_type"
        },
        "link": null
       },
       {
        "localized_name": "multiplier",
        "name": "resize_type.multiplier",
        "type": "FLOAT",
        "widget": {
         "name": "resize_type.multiplier"
        },
        "link": 962
       },
       {
        "localized_name": "缩放方法",
        "name": "scale_method",
        "type": "COMBO",
        "widget": {
         "name": "scale_method"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "已调整大小",
        "name": "resized",
        "type": "IMAGE",
        "links": [
         873,
         885
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "ResizeImageMaskNode",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       "scale by multiplier",
       4,
       "lanczos"
      ],
      "widgets_values_named": {
       "resize_type": "scale by multiplier",
       "resize_type.multiplier": 4,
       "scale_method": "lanczos"
      }
     },
     {
      "id": 576,
      "type": "JoinImageWithAlpha",
      "pos": [
       1030,
       2960
      ],
      "size": [
       280,
       80
      ],
      "flags": {},
      "order": 26,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "IMAGE",
        "link": 887
       },
       {
        "localized_name": "阿尔法",
        "name": "alpha",
        "type": "MASK",
        "link": 936
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         886
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "JoinImageWithAlpha",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      }
     },
     {
      "id": 481,
      "type": "VAEDecode",
      "pos": [
       710,
       2650
      ],
      "size": [
       230,
       60
      ],
      "flags": {},
      "order": 25,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "Latent",
        "name": "samples",
        "type": "LATENT",
        "link": 733
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "type": "VAE",
        "link": 731
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         887
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAEDecode"
      }
     },
     {
      "id": 488,
      "type": "LoadImage",
      "pos": [
       700,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 5,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         919
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": null
       }
      ],
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "portrait_model_denim.png",
       "image"
      ],
      "widgets_values_named": {
       "image": "portrait_model_denim.png",
       "upload": "image"
      }
     },
     {
      "id": 489,
      "type": "LoadImage",
      "pos": [
       1020,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 6,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         920
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": null
       }
      ],
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "portrait_model_denim.png",
       "image"
      ],
      "widgets_values_named": {
       "image": "portrait_model_denim.png",
       "upload": "image"
      }
     },
     {
      "id": 490,
      "type": "LoadImage",
      "pos": [
       1340,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 7,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         921
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": null
       }
      ],
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "portrait_model_denim.png",
       "image"
      ],
      "widgets_values_named": {
       "image": "portrait_model_denim.png",
       "upload": "image"
      }
     },
     {
      "id": 577,
      "type": "LoadImage",
      "pos": [
       1660,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 8,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         922
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": null
       }
      ],
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "portrait_model_denim.png",
       "image"
      ],
      "widgets_values_named": {
       "image": "portrait_model_denim.png",
       "upload": "image"
      }
     },
     {
      "id": 578,
      "type": "LoadImage",
      "pos": [
       1980,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 9,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         923
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": null
       }
      ],
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "portrait_model_denim.png",
       "image"
      ],
      "widgets_values_named": {
       "image": "portrait_model_denim.png",
       "upload": "image"
      }
     },
     {
      "id": 491,
      "type": "LoadImage",
      "pos": [
       380,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 10,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         918
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": null
       }
      ],
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "sdppp/491_w_r1790102216597_491_0_491_w.png",
       "image"
      ],
      "widgets_values_named": {
       "image": "sdppp/491_w_r1790102216597_491_0_491_w.png",
       "upload": "image"
      }
     },
     {
      "id": 470,
      "type": "LoadImage",
      "pos": [
       70,
       2120
      ],
      "size": [
       290,
       330
      ],
      "flags": {},
      "order": 11,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "COMBO",
        "widget": {
         "name": "image"
        },
        "link": null
       },
       {
        "localized_name": "选择文件上传",
        "name": "upload",
        "type": "IMAGEUPLOAD",
        "widget": {
         "name": "upload"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         935
        ]
       },
       {
        "localized_name": "遮罩",
        "name": "MASK",
        "type": "MASK",
        "links": [
         936
        ]
       }
      ],
      "title": "#06 主图",
      "properties": {
       "Node name for S&R": "LoadImage",
       "#sdppp_variant": "default",
       "#sdppp_simple_content": "canvas",
       "#sdppp_simple_mask": "canvas",
       "#sdppp_simple_boundary": "canvas",
       "#sdppp_label": ""
      },
      "widgets_values": [
       "",
       "image"
      ],
      "widgets_values_named": {
       "image": "",
       "upload": "image"
      }
     },
     {
      "id": 580,
      "type": "SaveImage",
      "pos": [
       2090,
       2590
      ],
      "size": [
       700,
       920
      ],
      "flags": {},
      "order": 34,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "图片",
        "name": "images",
        "type": "IMAGE",
        "link": 895
       },
       {
        "localized_name": "文件名前缀",
        "name": "filename_prefix",
        "type": "STRING",
        "widget": {
         "name": "filename_prefix"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "links": []
       }
      ],
      "title": "@37 保存图像",
      "properties": {
       "cnr_id": "comfy-core",
       "ver": "0.27.0",
       "Node name for S&R": "SaveImage"
      },
      "widgets_values": [
       "qwen图生图"
      ],
      "widgets_values_named": {
       "filename_prefix": "qwen图生图"
      },
      "color": "#2a363b",
      "bgcolor": "#3f5159"
     },
     {
      "id": 487,
      "type": "ResizeAndPadImage",
      "pos": [
       700,
       3330
      ],
      "size": [
       270,
       130
      ],
      "flags": {},
      "order": 18,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "IMAGE",
        "link": 935
       },
       {
        "localized_name": "目标宽度",
        "name": "target_width",
        "type": "INT",
        "widget": {
         "name": "target_width"
        },
        "link": null
       },
       {
        "localized_name": "目标高度",
        "name": "target_height",
        "type": "INT",
        "widget": {
         "name": "target_height"
        },
        "link": null
       },
       {
        "localized_name": "填充颜色",
        "name": "padding_color",
        "type": "COMBO",
        "widget": {
         "name": "padding_color"
        },
        "link": null
       },
       {
        "localized_name": "插值方法",
        "name": "interpolation",
        "type": "COMBO",
        "widget": {
         "name": "interpolation"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         753
        ]
       }
      ],
      "title": "@37 主流程图像预调整",
      "properties": {
       "Node name for S&R": "ResizeAndPadImage"
      },
      "widgets_values": [
       1024,
       1024,
       "white",
       "area"
      ],
      "widgets_values_named": {
       "target_width": 1024,
       "target_height": 1024,
       "padding_color": "white",
       "interpolation": "area"
      }
     },
     {
      "id": 485,
      "type": "TextEncodeQwenImage21",
      "pos": [
       -330,
       2670
      ],
      "size": [
       620,
       380
      ],
      "flags": {},
      "order": 21,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "clip",
        "name": "clip",
        "type": "CLIP",
        "link": 750
       },
       {
        "localized_name": "image_1",
        "name": "images.image_1",
        "shape": 7,
        "type": "IMAGE",
        "link": 753
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "shape": 7,
        "type": "VAE",
        "link": 745
       },
       {
        "localized_name": "prompt",
        "name": "prompt",
        "type": "STRING",
        "widget": {
         "name": "prompt"
        },
        "link": 945
       },
       {
        "localized_name": "negative_prompt",
        "name": "negative_prompt",
        "type": "STRING",
        "widget": {
         "name": "negative_prompt"
        },
        "link": 946
       },
       {
        "localized_name": "resolution",
        "name": "resolution",
        "type": "INT",
        "widget": {
         "name": "resolution"
        },
        "link": null
       },
       {
        "localized_name": "image_11",
        "name": "images.image_11",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "image_12",
        "name": "images.image_12",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "image_13",
        "name": "images.image_13",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "image_14",
        "name": "images.image_14",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "image_15",
        "name": "images.image_15",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "image_16",
        "name": "images.image_16",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "image_2",
        "name": "images.image_2",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "positive",
        "name": "positive",
        "type": "CONDITIONING",
        "links": [
         738
        ]
       },
       {
        "localized_name": "negative",
        "name": "negative",
        "type": "CONDITIONING",
        "links": [
         739
        ]
       },
       {
        "localized_name": "latent",
        "name": "latent",
        "type": "LATENT",
        "links": [
         740
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "TextEncodeQwenImage21"
      },
      "widgets_values": [
       "",
       "",
       1024
      ],
      "widgets_values_named": {
       "prompt": "",
       "negative_prompt": "",
       "resolution": 1024
      }
     },
     {
      "id": 486,
      "type": "LoraLoader",
      "pos": [
       -890,
       3280
      ],
      "size": [
       480,
       140
      ],
      "flags": {},
      "order": 17,
      "mode": 4,
      "inputs": [
       {
        "localized_name": "模型",
        "name": "model",
        "type": "MODEL",
        "link": 747
       },
       {
        "localized_name": "CLIP",
        "name": "clip",
        "type": "CLIP",
        "link": 749
       },
       {
        "localized_name": "LoRA名称",
        "name": "lora_name",
        "type": "COMBO",
        "widget": {
         "name": "lora_name"
        },
        "link": null
       },
       {
        "localized_name": "模型强度",
        "name": "strength_model",
        "type": "FLOAT",
        "widget": {
         "name": "strength_model"
        },
        "link": null
       },
       {
        "localized_name": "CLIP强度",
        "name": "strength_clip",
        "type": "FLOAT",
        "widget": {
         "name": "strength_clip"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         748
        ]
       },
       {
        "localized_name": "CLIP",
        "name": "CLIP",
        "type": "CLIP",
        "links": [
         750
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "LoraLoader"
      },
      "widgets_values": [
       null,
       1,
       1
      ],
      "widgets_values_named": {
       "lora_name": null,
       "strength_model": 1,
       "strength_clip": 1
      }
     },
     {
      "id": 574,
      "type": "SeedVR2PostProcessing",
      "pos": [
       1720,
       2960
      ],
      "size": [
       310,
       110
      ],
      "flags": {},
      "order": 33,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "link": 884
       },
       {
        "localized_name": "original_resized_images",
        "name": "original_resized_images",
        "type": "IMAGE",
        "link": 885
       },
       {
        "localized_name": "color_correction_method",
        "name": "color_correction_method",
        "type": "COMBO",
        "widget": {
         "name": "color_correction_method"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "links": [
         895
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "SeedVR2PostProcessing",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       "none"
      ],
      "widgets_values_named": {
       "color_correction_method": "none"
      }
     },
     {
      "id": 622,
      "type": "PrimitiveStringMultiline",
      "pos": [
       -920,
       2060
      ],
      "size": [
       400,
       200
      ],
      "flags": {},
      "order": 12,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "值",
        "name": "value",
        "type": "STRING",
        "widget": {
         "name": "value"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "字符串",
        "name": "STRING",
        "type": "STRING",
        "links": [
         945
        ]
       }
      ],
      "title": "#01 正向提示词",
      "properties": {
       "Node name for S&R": "PrimitiveStringMultiline",
       "sdppp_widgetable_title": "#01 正向提示词"
      },
      "widgets_values": [
       ""
      ],
      "widgets_values_named": {
       "value": ""
      }
     },
     {
      "id": 623,
      "type": "PrimitiveStringMultiline",
      "pos": [
       -920,
       2310
      ],
      "size": [
       400,
       200
      ],
      "flags": {},
      "order": 13,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "值",
        "name": "value",
        "type": "STRING",
        "widget": {
         "name": "value"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "字符串",
        "name": "STRING",
        "type": "STRING",
        "links": [
         946
        ]
       }
      ],
      "title": "#02 反向提示词",
      "properties": {
       "Node name for S&R": "PrimitiveStringMultiline",
       "sdppp_widgetable_title": "#02 反向提示词"
      },
      "widgets_values": [
       ""
      ],
      "widgets_values_named": {
       "value": ""
      }
     },
     {
      "id": 638,
      "type": "PrimitiveNode",
      "pos": [
       -470,
       2060
      ],
      "size": [
       440,
       110
      ],
      "flags": {},
      "order": 14,
      "mode": 0,
      "inputs": [],
      "outputs": [
       {
        "name": "COMBO",
        "type": "COMBO",
        "widget": {
         "name": "aspect_ratio"
        },
        "links": [
         958
        ]
       }
      ],
      "title": "#03 宽高比",
      "properties": {
       "Run widget replace on values": false,
       "sdppp_widgetable_title": "#03 宽高比"
      },
      "widgets_values": [
       "1:1 (Square)",
       "fixed",
       ""
      ],
      "widgets_values_named": {
       "value": "1:1 (Square)",
       "control_after_generate": "fixed",
       "control_filter_list": ""
      }
     },
     {
      "id": 643,
      "type": "PrimitiveFloat",
      "pos": [
       -470,
       2390
      ],
      "size": [
       270,
       70
      ],
      "flags": {},
      "order": 15,
      "mode": 0,
      "inputs": [
       {
        "label": "放大倍数",
        "localized_name": "值",
        "name": "value",
        "type": "FLOAT",
        "widget": {
         "name": "value"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "浮点",
        "name": "FLOAT",
        "type": "FLOAT",
        "links": [
         962
        ]
       }
      ],
      "title": "#05 最终出图的画质",
      "properties": {
       "Node name for S&R": "PrimitiveFloat",
       "sdppp_widgetable_title": "#05 最终出图的画质"
      },
      "widgets_values": [
       4
      ],
      "widgets_values_named": {
       "value": 4
      }
     },
     {
      "id": 646,
      "type": "PrimitiveInt",
      "pos": [
       -480,
       2240
      ],
      "size": [
       270,
       90
      ],
      "flags": {},
      "order": 16,
      "mode": 0,
      "inputs": [
       {
        "label": "步数",
        "localized_name": "数值",
        "name": "value",
        "type": "INT",
        "widget": {
         "name": "value"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "整数",
        "name": "INT",
        "type": "INT",
        "links": [
         964
        ]
       }
      ],
      "title": "#04 qwen步数",
      "properties": {
       "Node name for S&R": "PrimitiveInt",
       "sdppp_widgetable_title": "#04 qwen步数"
      },
      "widgets_values": [
       20,
       "fixed"
      ],
      "widgets_values_named": {
       "value": 20,
       "fixed": "fixed"
      }
     }
    ],
    "links": [
     [
      731,
      479,
      0,
      481,
      1,
      "VAE"
     ],
     [
      733,
      482,
      0,
      481,
      0,
      "LATENT"
     ],
     [
      734,
      483,
      0,
      482,
      3,
      "LATENT"
     ],
     [
      735,
      480,
      0,
      483,
      1,
      "LATENT"
     ],
     [
      737,
      484,
      0,
      482,
      0,
      "MODEL"
     ],
     [
      738,
      485,
      0,
      482,
      1,
      "CONDITIONING"
     ],
     [
      739,
      485,
      1,
      482,
      2,
      "CONDITIONING"
     ],
     [
      740,
      485,
      2,
      483,
      0,
      "LATENT"
     ],
     [
      741,
      13,
      0,
      480,
      0,
      "INT"
     ],
     [
      742,
      13,
      1,
      480,
      1,
      "INT"
     ],
     [
      745,
      479,
      0,
      485,
      2,
      "VAE"
     ],
     [
      747,
      477,
      0,
      486,
      0,
      "MODEL"
     ],
     [
      748,
      486,
      0,
      484,
      0,
      "MODEL"
     ],
     [
      749,
      478,
      0,
      486,
      1,
      "CLIP"
     ],
     [
      750,
      486,
      1,
      485,
      0,
      "CLIP"
     ],
     [
      753,
      487,
      0,
      485,
      1,
      "IMAGE"
     ],
     [
      873,
      575,
      0,
      569,
      0,
      "IMAGE"
     ],
     [
      874,
      568,
      0,
      570,
      0,
      "MODEL"
     ],
     [
      875,
      571,
      0,
      570,
      1,
      "LATENT"
     ],
     [
      876,
      569,
      0,
      571,
      0,
      "IMAGE"
     ],
     [
      877,
      567,
      0,
      571,
      1,
      "VAE"
     ],
     [
      878,
      568,
      0,
      572,
      0,
      "MODEL"
     ],
     [
      879,
      570,
      0,
      572,
      1,
      "CONDITIONING"
     ],
     [
      880,
      570,
      1,
      572,
      2,
      "CONDITIONING"
     ],
     [
      881,
      571,
      0,
      572,
      3,
      "LATENT"
     ],
     [
      882,
      572,
      0,
      573,
      0,
      "LATENT"
     ],
     [
      883,
      567,
      0,
      573,
      1,
      "VAE"
     ],
     [
      884,
      573,
      0,
      574,
      0,
      "IMAGE"
     ],
     [
      885,
      575,
      0,
      574,
      1,
      "IMAGE"
     ],
     [
      886,
      576,
      0,
      575,
      0,
      "IMAGE"
     ],
     [
      887,
      481,
      0,
      576,
      0,
      "IMAGE"
     ],
     [
      895,
      574,
      0,
      580,
      0,
      "IMAGE"
     ],
     [
      918,
      491,
      0,
      485,
      6,
      "IMAGE"
     ],
     [
      919,
      488,
      0,
      485,
      7,
      "IMAGE"
     ],
     [
      920,
      489,
      0,
      485,
      8,
      "IMAGE"
     ],
     [
      921,
      490,
      0,
      485,
      9,
      "IMAGE"
     ],
     [
      922,
      577,
      0,
      485,
      10,
      "IMAGE"
     ],
     [
      923,
      578,
      0,
      485,
      11,
      "IMAGE"
     ],
     [
      935,
      470,
      0,
      487,
      0,
      "IMAGE"
     ],
     [
      936,
      470,
      1,
      576,
      1,
      "MASK"
     ],
     [
      945,
      622,
      0,
      485,
      3,
      "STRING"
     ],
     [
      946,
      623,
      0,
      485,
      4,
      "STRING"
     ],
     [
      958,
      638,
      0,
      13,
      0,
      "COMBO"
     ],
     [
      962,
      643,
      0,
      575,
      2,
      "FLOAT"
     ],
     [
      964,
      646,
      0,
      482,
      5,
      "INT"
     ]
    ],
    "groups": [
     {
      "id": 34,
      "title": "Models",
      "bounding": [
       -920,
       2580,
       530,
       930
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 36,
      "title": "Conditioning",
      "bounding": [
       -370,
       2580,
       700,
       930
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 37,
      "title": "Sampling",
      "bounding": [
       340,
       2580,
       660,
       930
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 38,
      "title": "主图与参考图",
      "bounding": [
       50,
       2060,
       2270,
       450
      ],
      "color": "#8A8",
      "flags": {}
     },
     {
      "id": 46,
      "title": "放大",
      "bounding": [
       1020,
       2540,
       1030,
       980
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 1,
      "title": "模型加载",
      "bounding": [
       1030,
       2580,
       290,
       330.15625
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 47,
      "title": "Qwen-imagine-2.1 主流程",
      "bounding": [
       -930,
       2540,
       1940,
       980
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 48,
      "title": "链接",
      "bounding": [
       -930,
       1990,
       910,
       530
      ],
      "color": "#3f789e",
      "flags": {}
     }
    ],
    "config": {},
    "extra": {
     "ds": {
      "scale": 0.5188371205380035,
      "offset": [
       1054.7349548721602,
       -1516.7238876337353
      ]
     },
     "frontendVersion": "1.53.6",
     "VHS_latentpreview": false,
     "VHS_latentpreviewrate": 0,
     "VHS_MetadataImage": true,
     "VHS_KeepIntermediate": true,
     "linearData": {
      "inputs": [],
      "outputs": []
     },
     "linearMode": false
    },
    "version": 0.4
   },
   "promptCleared": true
  },
  {
   "id": "text2img",
   "name": "内置 · 文生图带放大",
   "badge": "内置",
   "sourceFile": "Qwen-imagine-2.1 文生图工作流（带放大版）.json",
   "description": "本机 ComfyUI 的文生图带放大工作流；已给正向提示词、LoRA、画幅补上 # 标记。；已清空固定提示词",
   "patched": true,
   "data": {
    "id": "e18bffaa-5dc2-466f-82d2-7bf0fd94cae5",
    "revision": 0,
    "last_node_id": 564,
    "last_link_id": 869,
    "nodes": [
     {
      "id": 549,
      "type": "VAELoader",
      "pos": [
       -380,
       1600
      ],
      "size": [
       270,
       80
      ],
      "flags": {},
      "order": 0,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "vae名称",
        "name": "vae_name",
        "type": "COMBO",
        "widget": {
         "name": "vae_name"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "VAE",
        "name": "VAE",
        "type": "VAE",
        "links": [
         833,
         839
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAELoader",
       "cnr_id": "comfy-core",
       "ver": "0.27.0",
       "models": [
        {
         "name": "seedvr2_ema_vae_fp16.safetensors",
         "url": "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors",
         "directory": "vae"
        }
       ]
      },
      "widgets_values": [
       "seedvr2_ema_vae_fp16.safetensors"
      ],
      "widgets_values_named": {
       "vae_name": "seedvr2_ema_vae_fp16.safetensors"
      }
     },
     {
      "id": 550,
      "type": "UNETLoader",
      "pos": [
       -380,
       1430
      ],
      "size": [
       270,
       110
      ],
      "flags": {},
      "order": 1,
      "mode": 0,
      "showAdvanced": false,
      "inputs": [
       {
        "localized_name": "UNet名称",
        "name": "unet_name",
        "type": "COMBO",
        "widget": {
         "name": "unet_name"
        },
        "link": null
       },
       {
        "localized_name": "数据类型",
        "name": "weight_dtype",
        "type": "COMBO",
        "widget": {
         "name": "weight_dtype"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         834,
         844
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "UNETLoader",
       "cnr_id": "comfy-core",
       "ver": "0.27.0",
       "models": [
        {
         "name": "seedvr2_7b_int8_convrot.safetensors",
         "url": "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors",
         "directory": "diffusion_models"
        }
       ]
      },
      "widgets_values": [
       "seedvr2_7b_int8_convrot.safetensors",
       "default"
      ],
      "widgets_values_named": {
       "unet_name": "seedvr2_7b_int8_convrot.safetensors",
       "weight_dtype": "default"
      }
     },
     {
      "id": 554,
      "type": "SeedVR2Preprocess",
      "pos": [
       -390,
       2070
      ],
      "size": [
       270,
       60
      ],
      "flags": {},
      "order": 13,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "resized_images",
        "name": "resized_images",
        "type": "IMAGE",
        "link": 841
       }
      ],
      "outputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "links": [
         832
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "SeedVR2Preprocess",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      }
     },
     {
      "id": 556,
      "type": "SeedVR2Conditioning",
      "pos": [
       -20,
       1400
      ],
      "size": [
       270,
       80
      ],
      "flags": {},
      "order": 15,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "model",
        "name": "model",
        "type": "MODEL",
        "link": 844
       },
       {
        "label": "latent",
        "localized_name": "vae_conditioning",
        "name": "vae_conditioning",
        "type": "LATENT",
        "link": 845
       }
      ],
      "outputs": [
       {
        "localized_name": "positive",
        "name": "positive",
        "type": "CONDITIONING",
        "links": [
         835
        ]
       },
       {
        "localized_name": "negative",
        "name": "negative",
        "type": "CONDITIONING",
        "links": [
         836
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "SeedVR2Conditioning",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      }
     },
     {
      "id": 547,
      "type": "VAEEncodeTiled",
      "pos": [
       -20,
       1540
      ],
      "size": [
       270,
       230
      ],
      "flags": {},
      "order": 14,
      "mode": 0,
      "showAdvanced": true,
      "inputs": [
       {
        "localized_name": "像素",
        "name": "pixels",
        "type": "IMAGE",
        "link": 832
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "type": "VAE",
        "link": 833
       },
       {
        "localized_name": "分块尺寸",
        "name": "tile_size",
        "type": "INT",
        "widget": {
         "name": "tile_size"
        },
        "link": null
       },
       {
        "localized_name": "重叠",
        "name": "overlap",
        "type": "INT",
        "widget": {
         "name": "overlap"
        },
        "link": null
       },
       {
        "localized_name": "时间尺寸",
        "name": "temporal_size",
        "type": "INT",
        "widget": {
         "name": "temporal_size"
        },
        "link": null
       },
       {
        "localized_name": "时间重叠",
        "name": "temporal_overlap",
        "type": "INT",
        "widget": {
         "name": "temporal_overlap"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         837,
         845
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAEEncodeTiled",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       512,
       128,
       4096,
       8
      ],
      "widgets_values_named": {
       "tile_size": 512,
       "overlap": 128,
       "temporal_size": 4096,
       "temporal_overlap": 8
      }
     },
     {
      "id": 551,
      "type": "KSampler",
      "pos": [
       -20,
       1830
      ],
      "size": [
       270,
       320
      ],
      "flags": {},
      "order": 16,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "模型",
        "name": "model",
        "type": "MODEL",
        "link": 834
       },
       {
        "localized_name": "正面条件",
        "name": "positive",
        "type": "CONDITIONING",
        "link": 835
       },
       {
        "localized_name": "负面条件",
        "name": "negative",
        "type": "CONDITIONING",
        "link": 836
       },
       {
        "localized_name": "Latent图像",
        "name": "latent_image",
        "type": "LATENT",
        "link": 837
       },
       {
        "localized_name": "种子",
        "name": "seed",
        "type": "INT",
        "widget": {
         "name": "seed"
        },
        "link": null
       },
       {
        "localized_name": "步数",
        "name": "steps",
        "type": "INT",
        "widget": {
         "name": "steps"
        },
        "link": null
       },
       {
        "localized_name": "cfg",
        "name": "cfg",
        "type": "FLOAT",
        "widget": {
         "name": "cfg"
        },
        "link": null
       },
       {
        "localized_name": "采样器名称",
        "name": "sampler_name",
        "type": "COMBO",
        "widget": {
         "name": "sampler_name"
        },
        "link": null
       },
       {
        "localized_name": "调度器",
        "name": "scheduler",
        "type": "COMBO",
        "widget": {
         "name": "scheduler"
        },
        "link": null
       },
       {
        "localized_name": "降噪",
        "name": "denoise",
        "type": "FLOAT",
        "widget": {
         "name": "denoise"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         838
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "KSampler",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       959948902156062,
       "fixed",
       1,
       1,
       "euler",
       "simple",
       1
      ],
      "widgets_values_named": {
       "seed": 959948902156062,
       "control_after_generate": "fixed",
       "steps": 1,
       "cfg": 1,
       "sampler_name": "euler",
       "scheduler": "simple",
       "denoise": 1
      }
     },
     {
      "id": 552,
      "type": "VAEDecodeTiled",
      "pos": [
       320,
       1410
      ],
      "size": [
       270,
       230
      ],
      "flags": {},
      "order": 17,
      "mode": 0,
      "showAdvanced": true,
      "inputs": [
       {
        "localized_name": "Latent",
        "name": "samples",
        "type": "LATENT",
        "link": 838
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "type": "VAE",
        "link": 839
       },
       {
        "localized_name": "分块尺寸",
        "name": "tile_size",
        "type": "INT",
        "widget": {
         "name": "tile_size"
        },
        "link": null
       },
       {
        "localized_name": "重叠",
        "name": "overlap",
        "type": "INT",
        "widget": {
         "name": "overlap"
        },
        "link": null
       },
       {
        "localized_name": "时间尺寸",
        "name": "temporal_size",
        "type": "INT",
        "widget": {
         "name": "temporal_size"
        },
        "link": null
       },
       {
        "localized_name": "时间重叠",
        "name": "temporal_overlap",
        "type": "INT",
        "widget": {
         "name": "temporal_overlap"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         842
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAEDecodeTiled",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       512,
       128,
       4096,
       8
      ],
      "widgets_values_named": {
       "tile_size": 512,
       "overlap": 128,
       "temporal_size": 4096,
       "temporal_overlap": 8
      }
     },
     {
      "id": 555,
      "type": "SeedVR2PostProcessing",
      "pos": [
       310,
       1720
      ],
      "size": [
       310,
       110
      ],
      "flags": {},
      "order": 18,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "link": 842
       },
       {
        "localized_name": "original_resized_images",
        "name": "original_resized_images",
        "type": "IMAGE",
        "link": 843
       },
       {
        "localized_name": "color_correction_method",
        "name": "color_correction_method",
        "type": "COMBO",
        "widget": {
         "name": "color_correction_method"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "links": [
         848
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "SeedVR2PostProcessing",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       "none"
      ],
      "widgets_values_named": {
       "color_correction_method": "none"
      }
     },
     {
      "id": 559,
      "type": "CLIPLoader",
      "pos": [
       -390,
       2580
      ],
      "size": [
       510,
       120
      ],
      "flags": {},
      "order": 2,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "CLIP名称",
        "name": "clip_name",
        "type": "COMBO",
        "widget": {
         "name": "clip_name"
        },
        "link": null
       },
       {
        "localized_name": "类型",
        "name": "type",
        "type": "COMBO",
        "widget": {
         "name": "type"
        },
        "link": null
       },
       {
        "localized_name": "设备",
        "name": "device",
        "shape": 7,
        "type": "COMBO",
        "widget": {
         "name": "device"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "CLIP",
        "name": "CLIP",
        "type": "CLIP",
        "links": [
         861
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "CLIPLoader",
       "models": [
        {
         "name": "qwen3vl_8b_int8_convrot.safetensors",
         "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
         "directory": "text_encoders"
        }
       ]
      },
      "widgets_values": [
       "qwen3vl_8b_int8_convrot.safetensors",
       "qwen_image",
       "default"
      ],
      "widgets_values_named": {
       "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
       "type": "qwen_image",
       "device": "default"
      }
     },
     {
      "id": 560,
      "type": "VAELoader",
      "pos": [
       -390,
       2780
      ],
      "size": [
       510,
       70
      ],
      "flags": {},
      "order": 3,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "vae名称",
        "name": "vae_name",
        "type": "COMBO",
        "widget": {
         "name": "vae_name"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "VAE",
        "name": "VAE",
        "type": "VAE",
        "links": [
         850
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAELoader",
       "models": [
        {
         "name": "qwen_image_2.1_vae_bf16.safetensors",
         "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
         "directory": "vae"
        }
       ]
      },
      "widgets_values": [
       "qwen_image_2.1_vae_bf16.safetensors"
      ],
      "widgets_values_named": {
       "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
      }
     },
     {
      "id": 561,
      "type": "EmptyLatentImage",
      "pos": [
       1020,
       2810
      ],
      "size": [
       300,
       120
      ],
      "flags": {},
      "order": 6,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "宽度",
        "name": "width",
        "type": "INT",
        "widget": {
         "name": "width"
        },
        "link": 856
       },
       {
        "localized_name": "高度",
        "name": "height",
        "type": "INT",
        "widget": {
         "name": "height"
        },
        "link": 857
       },
       {
        "localized_name": "批量大小",
        "name": "batch_size",
        "type": "INT",
        "widget": {
         "name": "batch_size"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         854
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "EmptyLatentImage"
      },
      "widgets_values": [
       1024,
       1024,
       1
      ],
      "widgets_values_named": {
       "width": 1024,
       "height": 1024,
       "batch_size": 1
      }
     },
     {
      "id": 471,
      "type": "ResolutionSelector",
      "pos": [
       930,
       2970
      ],
      "size": [
       400,
       190
      ],
      "flags": {},
      "order": 4,
      "mode": 0,
      "showAdvanced": true,
      "inputs": [
       {
        "localized_name": "宽高比",
        "name": "aspect_ratio",
        "type": "COMBO",
        "widget": {
         "name": "aspect_ratio"
        },
        "link": null
       },
       {
        "localized_name": "百万像素",
        "name": "megapixels",
        "type": "FLOAT",
        "widget": {
         "name": "megapixels"
        },
        "link": null
       },
       {
        "localized_name": "倍数",
        "name": "multiple",
        "type": "INT",
        "widget": {
         "name": "multiple"
        },
        "link": null
       },
       {
        "localized_name": "预览",
        "name": "preview",
        "shape": 7,
        "type": "RESOLUTION_PREVIEW",
        "widget": {
         "name": "preview"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "宽度",
        "name": "width",
        "type": "INT",
        "links": [
         856
        ]
       },
       {
        "localized_name": "高度",
        "name": "height",
        "type": "INT",
        "links": [
         857
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "ResolutionSelector"
      },
      "widgets_values": [
       "1:1 (Square)",
       4,
       8
      ],
      "widgets_values_named": {
       "aspect_ratio": "1:1 (Square)",
       "megapixels": 4,
       "multiple": 8
      },
      "color": "#232",
      "bgcolor": "#353",
      "title": "#03 画幅"
     },
     {
      "id": 557,
      "type": "UNETLoader",
      "pos": [
       -390,
       2420
      ],
      "size": [
       510,
       90
      ],
      "flags": {},
      "order": 5,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "UNet名称",
        "name": "unet_name",
        "type": "COMBO",
        "widget": {
         "name": "unet_name"
        },
        "link": null
       },
       {
        "localized_name": "数据类型",
        "name": "weight_dtype",
        "type": "COMBO",
        "widget": {
         "name": "weight_dtype"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         859
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "UNETLoader",
       "models": [
        {
         "name": "qwen_image_2.1_int8_convrot.safetensors",
         "url": "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
         "directory": "diffusion_models"
        }
       ]
      },
      "widgets_values": [
       "qwen_image_2.1_int8_convrot.safetensors",
       "default"
      ],
      "widgets_values_named": {
       "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
       "weight_dtype": "default"
      }
     },
     {
      "id": 563,
      "type": "KSampler",
      "pos": [
       950,
       2380
      ],
      "size": [
       270,
       270
      ],
      "flags": {},
      "order": 9,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "模型",
        "name": "model",
        "type": "MODEL",
        "link": 860
       },
       {
        "localized_name": "正面条件",
        "name": "positive",
        "type": "CONDITIONING",
        "link": 853
       },
       {
        "localized_name": "负面条件",
        "name": "negative",
        "type": "CONDITIONING",
        "link": 855
       },
       {
        "localized_name": "Latent图像",
        "name": "latent_image",
        "type": "LATENT",
        "link": 854
       },
       {
        "localized_name": "种子",
        "name": "seed",
        "type": "INT",
        "widget": {
         "name": "seed"
        },
        "link": null
       },
       {
        "localized_name": "步数",
        "name": "steps",
        "type": "INT",
        "widget": {
         "name": "steps"
        },
        "link": null
       },
       {
        "localized_name": "cfg",
        "name": "cfg",
        "type": "FLOAT",
        "widget": {
         "name": "cfg"
        },
        "link": null
       },
       {
        "localized_name": "采样器名称",
        "name": "sampler_name",
        "type": "COMBO",
        "widget": {
         "name": "sampler_name"
        },
        "link": null
       },
       {
        "localized_name": "调度器",
        "name": "scheduler",
        "type": "COMBO",
        "widget": {
         "name": "scheduler"
        },
        "link": null
       },
       {
        "localized_name": "降噪",
        "name": "denoise",
        "type": "FLOAT",
        "widget": {
         "name": "denoise"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "Latent",
        "name": "LATENT",
        "type": "LATENT",
        "links": [
         852
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "KSampler"
      },
      "widgets_values": [
       0,
       "fixed",
       25,
       1,
       "euler",
       "simple",
       1
      ],
      "widgets_values_named": {
       "seed": 0,
       "control_after_generate": "fixed",
       "steps": 25,
       "cfg": 1,
       "sampler_name": "euler",
       "scheduler": "simple",
       "denoise": 1
      }
     },
     {
      "id": 558,
      "type": "TextEncodeQwenImage21",
      "pos": [
       240,
       2420
      ],
      "size": [
       530,
       680
      ],
      "flags": {},
      "order": 8,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "clip",
        "name": "clip",
        "type": "CLIP",
        "link": 862
       },
       {
        "localized_name": "image_1",
        "name": "images.image_1",
        "shape": 7,
        "type": "IMAGE",
        "link": null
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "shape": 7,
        "type": "VAE",
        "link": null
       },
       {
        "localized_name": "prompt",
        "name": "prompt",
        "type": "STRING",
        "widget": {
         "name": "prompt"
        },
        "link": null
       },
       {
        "localized_name": "negative_prompt",
        "name": "negative_prompt",
        "type": "STRING",
        "widget": {
         "name": "negative_prompt"
        },
        "link": null
       },
       {
        "localized_name": "resolution",
        "name": "resolution",
        "type": "INT",
        "widget": {
         "name": "resolution"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "positive",
        "name": "positive",
        "type": "CONDITIONING",
        "links": [
         853
        ]
       },
       {
        "localized_name": "negative",
        "name": "negative",
        "type": "CONDITIONING",
        "links": [
         855
        ]
       },
       {
        "localized_name": "latent",
        "name": "latent",
        "type": "LATENT",
        "links": []
       }
      ],
      "properties": {
       "Node name for S&R": "TextEncodeQwenImage21"
      },
      "widgets_values": [
       "",
       "",
       1024
      ],
      "widgets_values_named": {
       "prompt": "",
       "negative_prompt": "",
       "resolution": 1024
      },
      "title": "#01 正向提示词"
     },
     {
      "id": 564,
      "type": "LoraLoader",
      "pos": [
       -280,
       3020
      ],
      "size": [
       270,
       130
      ],
      "flags": {},
      "order": 7,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "模型",
        "name": "model",
        "type": "MODEL",
        "link": 859
       },
       {
        "localized_name": "CLIP",
        "name": "clip",
        "type": "CLIP",
        "link": 861
       },
       {
        "localized_name": "LoRA名称",
        "name": "lora_name",
        "type": "COMBO",
        "widget": {
         "name": "lora_name"
        },
        "link": null
       },
       {
        "localized_name": "模型强度",
        "name": "strength_model",
        "type": "FLOAT",
        "widget": {
         "name": "strength_model"
        },
        "link": null
       },
       {
        "localized_name": "CLIP强度",
        "name": "strength_clip",
        "type": "FLOAT",
        "widget": {
         "name": "strength_clip"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "模型",
        "name": "MODEL",
        "type": "MODEL",
        "links": [
         860
        ]
       },
       {
        "localized_name": "CLIP",
        "name": "CLIP",
        "type": "CLIP",
        "links": [
         862
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "LoraLoader"
      },
      "widgets_values": [
       null,
       1,
       1
      ],
      "widgets_values_named": {
       "lora_name": null,
       "strength_model": 1,
       "strength_clip": 1
      },
      "title": "#02 LoRA"
     },
     {
      "id": 562,
      "type": "VAEDecode",
      "pos": [
       910,
       2700
      ],
      "size": [
       230,
       60
      ],
      "flags": {},
      "order": 10,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "Latent",
        "name": "samples",
        "type": "LATENT",
        "link": 852
       },
       {
        "localized_name": "vae",
        "name": "vae",
        "type": "VAE",
        "link": 850
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         868
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "VAEDecode"
      }
     },
     {
      "id": 553,
      "type": "ResizeImageMaskNode",
      "pos": [
       -390,
       1870
      ],
      "size": [
       270,
       110
      ],
      "flags": {},
      "order": 12,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "输入",
        "name": "input",
        "type": "IMAGE,MASK",
        "link": 869
       },
       {
        "localized_name": "调整类型",
        "name": "resize_type",
        "type": "COMFY_DYNAMICCOMBO_V3",
        "widget": {
         "name": "resize_type"
        },
        "link": null
       },
       {
        "localized_name": "multiplier",
        "name": "resize_type.multiplier",
        "type": "FLOAT",
        "widget": {
         "name": "resize_type.multiplier"
        },
        "link": null
       },
       {
        "localized_name": "缩放方法",
        "name": "scale_method",
        "type": "COMBO",
        "widget": {
         "name": "scale_method"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "已调整大小",
        "name": "resized",
        "type": "IMAGE",
        "links": [
         841,
         843
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "ResizeImageMaskNode",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      },
      "widgets_values": [
       "scale by multiplier",
       4,
       "lanczos"
      ],
      "widgets_values_named": {
       "resize_type": "scale by multiplier",
       "resize_type.multiplier": 4,
       "scale_method": "lanczos"
      }
     },
     {
      "id": 548,
      "type": "JoinImageWithAlpha",
      "pos": [
       -390,
       1740
      ],
      "size": [
       280,
       80
      ],
      "flags": {},
      "order": 11,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "图像",
        "name": "image",
        "type": "IMAGE",
        "link": 868
       },
       {
        "localized_name": "阿尔法",
        "name": "alpha",
        "type": "MASK",
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "图像",
        "name": "IMAGE",
        "type": "IMAGE",
        "links": [
         869
        ]
       }
      ],
      "properties": {
       "Node name for S&R": "JoinImageWithAlpha",
       "cnr_id": "comfy-core",
       "ver": "0.27.0"
      }
     },
     {
      "id": 529,
      "type": "SaveImage",
      "pos": [
       720,
       1400
      ],
      "size": [
       650,
       820
      ],
      "flags": {},
      "order": 19,
      "mode": 0,
      "inputs": [
       {
        "localized_name": "图片",
        "name": "images",
        "type": "IMAGE",
        "link": 848
       },
       {
        "localized_name": "文件名前缀",
        "name": "filename_prefix",
        "type": "STRING",
        "widget": {
         "name": "filename_prefix"
        },
        "link": null
       }
      ],
      "outputs": [
       {
        "localized_name": "images",
        "name": "images",
        "type": "IMAGE",
        "links": []
       }
      ],
      "properties": {
       "cnr_id": "comfy-core",
       "ver": "0.27.0",
       "Node name for S&R": "SaveImage"
      },
      "widgets_values": [
       "qwen图生图"
      ],
      "widgets_values_named": {
       "filename_prefix": "qwen图生图"
      },
      "color": "#2a363b",
      "bgcolor": "#3f5159"
     }
    ],
    "links": [
     [
      832,
      554,
      0,
      547,
      0,
      "IMAGE"
     ],
     [
      833,
      549,
      0,
      547,
      1,
      "VAE"
     ],
     [
      834,
      550,
      0,
      551,
      0,
      "MODEL"
     ],
     [
      835,
      556,
      0,
      551,
      1,
      "CONDITIONING"
     ],
     [
      836,
      556,
      1,
      551,
      2,
      "CONDITIONING"
     ],
     [
      837,
      547,
      0,
      551,
      3,
      "LATENT"
     ],
     [
      838,
      551,
      0,
      552,
      0,
      "LATENT"
     ],
     [
      839,
      549,
      0,
      552,
      1,
      "VAE"
     ],
     [
      841,
      553,
      0,
      554,
      0,
      "IMAGE"
     ],
     [
      842,
      552,
      0,
      555,
      0,
      "IMAGE"
     ],
     [
      843,
      553,
      0,
      555,
      1,
      "IMAGE"
     ],
     [
      844,
      550,
      0,
      556,
      0,
      "MODEL"
     ],
     [
      845,
      547,
      0,
      556,
      1,
      "LATENT"
     ],
     [
      848,
      555,
      0,
      529,
      0,
      "IMAGE"
     ],
     [
      850,
      560,
      0,
      562,
      1,
      "VAE"
     ],
     [
      852,
      563,
      0,
      562,
      0,
      "LATENT"
     ],
     [
      853,
      558,
      0,
      563,
      1,
      "CONDITIONING"
     ],
     [
      854,
      561,
      0,
      563,
      3,
      "LATENT"
     ],
     [
      855,
      558,
      1,
      563,
      2,
      "CONDITIONING"
     ],
     [
      856,
      471,
      0,
      561,
      0,
      "INT"
     ],
     [
      857,
      471,
      1,
      561,
      1,
      "INT"
     ],
     [
      859,
      557,
      0,
      564,
      0,
      "MODEL"
     ],
     [
      860,
      564,
      0,
      563,
      0,
      "MODEL"
     ],
     [
      861,
      559,
      0,
      564,
      1,
      "CLIP"
     ],
     [
      862,
      564,
      1,
      558,
      0,
      "CLIP"
     ],
     [
      868,
      562,
      0,
      548,
      0,
      "IMAGE"
     ],
     [
      869,
      548,
      0,
      553,
      0,
      "IMAGE"
     ]
    ],
    "groups": [
     {
      "id": 44,
      "title": "导出",
      "bounding": [
       700,
       1320,
       690,
       920
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 46,
      "title": "放大",
      "bounding": [
       -400,
       1320,
       1060,
       920
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 1,
      "title": "模型加载",
      "bounding": [
       -390,
       1360,
       290,
       330.15625
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 47,
      "title": "文生图",
      "bounding": [
       -410,
       2270,
       1800,
       920
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 34,
      "title": "Models",
      "bounding": [
       -400,
       2310,
       530,
       590
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 35,
      "title": "lora加载器",
      "bounding": [
       -400,
       2930,
       530,
       250
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 36,
      "title": "Conditioning",
      "bounding": [
       160,
       2310,
       700,
       860
      ],
      "color": "#3f789e",
      "flags": {}
     },
     {
      "id": 37,
      "title": "Sampling",
      "bounding": [
       890,
       2310,
       470,
       860
      ],
      "color": "#3f789e",
      "flags": {}
     }
    ],
    "config": {},
    "extra": {
     "ds": {
      "scale": 0.5267260289061514,
      "offset": [
       1400.3168838923982,
       -1102.2227993540569
      ]
     }
    },
    "version": 0.4
   },
   "promptCleared": true
  }
 ],
 "promptCleared": true,
 "clearedPromptCount": 2
};
})(typeof window !== 'undefined' ? window : globalThis);
