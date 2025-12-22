# services/

这是插件的“服务层”，把原先集中在一个文件里的逻辑拆成多个可维护模块。

模块说明
- common.py：通用工具（字符串处理、排序、pack csv 解析、事件用户信息）。
- io.py：OneBot I/O（解析图片/文件 URL、发图、上传文件）。
- typst.py：Typst 调用封装与 root 计算。
- pack.py：pack-v2 解析 + EULA 校验。
- assets.py：asset 数据库与 /mmt-asset 操作。
- img.py：/mmt-img 与 /mmt-imgmatch 管线。
- mmt.py：/mmt 与 /mmtpdf 管线（解析 -> resolve -> 渲染 -> 发送）。
- core.py：兼容层（旧 import 路径的 re-export）。

调用过程（mmt）
1) commands/mmt.py -> services/mmt.handle_mmt_common
2) services/mmt.parse_flags -> services/mmt.pipe_to_outputs
3) services/mmt.pipe_to_outputs -> resolve_expressions -> services/typst.run_typst
4) services/io.send_onebot_images 或 services/io.upload_onebot_file

调用过程（mmt-imgmatch）
1) commands/img.py -> services/img.handle_imgmatch
2) services/img.handle_imgmatch -> embedding(可选) -> rerank
3) services/typst.run_typst -> services/io.send_onebot_images

调用过程（mmt-img）
1) commands/img.py -> services/img.handle_mmt_img
2) services/img.handle_mmt_img -> services/typst.run_typst
3) services/io.send_onebot_images

调用过程（mmt-asset）
1) commands/asset.py -> services/assets.handle_mmt_asset
2) services/assets.handle_mmt_asset -> assets_store / io.extract_image_url

调用过程（mmt-pack）
1) commands/pack.py -> services/pack.handle_mmt_pack
2) services/pack.handle_mmt_pack -> pack-v2 / EULA 数据库
