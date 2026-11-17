# F2A 启动拒绝修复

用户在 Figwright 移植后无法启动 F2A，控制台截图显示
`SyntaxError: possible import expression rejected around line 1`。

已确认 Figma 注册的安装目录是指向 `D:\Tools\F2A` 的 junction，读取的是本仓库构建产物。
触发点位于移植提交 `4149ef6` 的 `figma-plugin/code.js` 第 22299 行：Zod 的
`json-schema-generator` 普通注释中包含动态导入写法。沙箱在解析代码前扫描源码文本，
注释也会命中。对应行为可查阅 [SES 转换源码](https://github.com/endojs/endo/blob/master/packages/ses/src/transforms.js)
及 [Figma 插件类型仓库的相关问题](https://github.com/figma/plugin-typings/issues/36)。

修复在插件打包阶段开启 esbuild `minifyWhitespace`，由打包器删除注释；按照用户要求，
同时设置 `legalComments:'none'` 并移除生成脚本中的许可头。许可通过独立文件随包提供，
函数名、原始上游源码、工具参数与实现保持不变。

在 `tests/mcp.cjs` 的实际插件加载入口加入相同类别的源码扫描。修复前稳定复现
`Figma startup: possible import expression rejected around line 22299`；修复后可通过
文本预检，再运行完整的 iframe/中继/插件命令链路。

验证：`mcp` 目录的 `npm run build`、`npm test`，以及 `export-options.cjs`、
`export-fidelity.cjs`、`direct-aep-ui.cjs` 全部通过。

真实 Figma 中已观察到“L50 车牌”文档重新建立 F2A 连接；通过现有中继向该连接执行
只读 `ping` 和 `get_metadata` 均成功，返回当前页面“正式稿件 3”、`editorType:figma`、
`apiVersion:1.0.0`。这验证了真实插件能够启动并执行新增命令；没有修改画布内容。
