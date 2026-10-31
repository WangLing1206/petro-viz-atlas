# 井场模型（glTF 2.0）

同一份模型的三种形态：

| 文件 | 说明 |
|---|---|
| `wellpad.gltf` | 标准 glTF，缓冲以 data URI 内嵌。可直接拖进 Blender / three.js editor / 在线查看器检查 |
| `wellpad.glb` | 二进制 glTF（BIN 块），供 http 环境或其它工具使用 |
| `wellpad.glb.js` | `window.WELLPAD_GLB = "…base64…"`：`file://` 下实际加载的那一份（浏览器会拦本地 XHR，所以内联） |

## 生成

```bash
node tools/build-model.mjs
```

几何在脚本里用两个原语拼装：`beam(a, b, w, h)`（两点之间的梁）与 `cylinder(a, b, r, seg)`。
单位米，原点在井口正下方地面，y 轴向上；游车节点名为 `travelingBlock`，会在场景里做升降动画。

## 换成你自己的模型

1. 准备一个 glTF/GLB（单位米、y 向上、原点在井口）。
2. 转成内联形式：

```bash
node -e "const fs=require('fs');const b=fs.readFileSync('your.glb').toString('base64');fs.writeFileSync('assets/models/wellpad.glb.js','window.WELLPAD_GLB=\"'+b+'\";\n')"
```

3. 刷新页面。模型解析失败时页面会自动降级，不会白屏。

## 当前模型

- 三角面 7376，材质 6 种（混凝土 / 钢 / 漆面 / 琥珀 / 罐体 / 火炬发光）
- **井架**：36 m 高、7 层格构；主腿逐层收口（底 3.6 m → 顶 1.65 m），每层横撑 + X 斜撑，两层一道剪刀撑；二层台（23.5 m）+ 围栏；天车台 + 4 组滑轮 + 天车罩；笼式梯子（28 级踏棍 + 7 道护笼）；井架工作灯 ×4
- **底座与钻台**：4 根格构柱（分段 + 双道横撑 + 双向斜撑）→ 钻台面（边梁 + 内梁网格 + 台面板 + 挡脚板）→ 三面栏杆 + 斜梯（10 级）
- **钻台设备**：转盘、绞车（含滚筒与电机）、司钻房（带窗带顶）、猫道 + 管排（10 根）、井架内立根（12 根）
- **井口**：四闸板防喷器组（4 节 + 侧向液压管线）、泥浆返出立管/鹅颈/回流管、节流管汇
- **地面**：储罐 ×2（带罐顶与连通管线）、泥浆泵房 + 3 台泵、火炬 + 4 腿塔架、地面管排
- **游车与顶驱**：单独节点 `travelingBlock`，场景里做升降动画；顶驱挂在游车下方
