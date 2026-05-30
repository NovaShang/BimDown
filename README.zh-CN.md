# BimDown

[![NPM Version](https://img.shields.io/npm/v/bimdown-cli.svg)](https://www.npmjs.com/package/bimdown-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI Status](https://github.com/NovaShang/BimDown/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaShang/BimDown/actions)

[English](./README.md)

开源的 AI 原生建筑数据格式、命令行工具以及 **BIM 领域 AI Agent Skill** — **支持与 Autodesk Revit 双向互通（Round-Trip）**。

BimDown 用 **CSV** 存储属性，几何层可以用 **SVG**（二维）或 **GeoJSON**（二维/三维）两种方式编码 — 简单到任何大语言模型都能直接读写，同时又足够结构化来支撑真实的 BIM 工作流。两种几何编码都是一等公民、可互相转换；新项目默认使用 GeoJSON。内置的 Revit 插件实现了**双向同步**：从 Revit 导出到 BimDown，用 AI 或手动修改数据，再导回 Revit，改动完整保留。

## 配合 AI Agent 使用 (BIM Skill)

BimDown 天生为 AI Agent 设计，支持 **OpenClaw**、**Claude Code**、**Gemini CLI**、**Cursor**、**VS Code + Copilot**、**Antigravity** 等所有支持 Agent Skill / 自定义指令的 Agent。通过安装 **BimDown AI Agent Skill**，你的小龙虾可以学习完整的 BIM 数据模式、坐标规则和 CLI 用法 — 从而自主创建、查询和修改建筑模型。

### 配置

将以下内容复制粘贴到你的 AI 对话中：

> 安装 BimDown CLI：`npm install -g bimdown-cli`。下载 Skill 文件 https://raw.githubusercontent.com/NovaShang/BimDown/main/agent-skill/SKILL.md ，并安装到 `<你的全局Skill目录>/bimdown/SKILL.md`。

### Agent 能做什么

配置完成后，Agent 可以：
- 根据自然语言描述创建建筑平面图
- 用 SQL 查询建筑数据（例如"找出所有厚度超过 0.3m 的墙"）
- 修改几何和属性，然后验证结果
- 渲染可视化蓝图供审查

### 自定义 Skill

要添加自定义领域能力（如能耗模型、ESG 报告），可以生成你自己的 Skill 定义：

```bash
bimdown generate-skill
```

## Revit 双向互通

`revit-addin/` 目录包含一个适用于 Autodesk Revit 2025+ 的 C# 插件，实现 Revit 模型与 BimDown 格式之间的**双向同步**：

- **导出**：Revit 模型 -> BimDown（CSV + SVG 或 GeoJSON 文件）
- **导入**：BimDown（CSV + SVG 或 GeoJSON 文件）-> Revit 模型
- **Round-Trip**：导出、用 AI 或手工编辑、导回 — 改动应用到原始 Revit 模型

**安装**：
从 [GitHub Releases](https://github.com/NovaShang/BimDown/releases) 页面下载最新的 `BimDownInstaller.exe` 并运行。

**手动构建（Windows）**：
```powershell
cd revit-addin
.\publish.ps1
```

## CLI

```bash
npm install -g bimdown-cli
```

### 项目管理

```bash
bimdown init ./my-project               # 创建新的 BimDown 项目
bimdown build ./my-project               # 验证并计算边界（别名：validate）
bimdown info ./my-project                # 打印项目概要（楼层、构件数量）
```

### 查询

BimDown 将所有 CSV 文件加载到内存中的 DuckDB 数据库，几何字段（长度、面积、起止坐标）从几何层（SVG 或 GeoJSON）自动计算。使用标准 SQL 查询：

```bash
# 列出所有墙及其长度
bimdown query ./my-project "SELECT id, material, length FROM wall"

# 查找厚墙
bimdown query ./my-project "SELECT id, thickness FROM wall WHERE thickness > 0.3"

# 按楼层统计门的数量
bimdown query ./my-project "SELECT level_id, COUNT(*) FROM door GROUP BY level_id"

# JSON 输出（便于脚本处理）
bimdown query ./my-project "SELECT * FROM wall" --json
```

### Schema 查看

```bash
bimdown schema              # 列出所有构件类型及其字段
bimdown schema wall          # 查看特定构件类型的字段
```

### 渲染

```bash
bimdown render ./my-project                     # 渲染 lv-1 到 render.svg
bimdown render ./my-project -l lv-3             # 渲染指定楼层
bimdown render ./my-project -o blueprint.svg    # 自定义输出路径
```

### 差异对比与合并

```bash
bimdown diff ./project-v1 ./project-v2          # 显示结构差异（+, -, ~）
bimdown merge ./projectA ./projectB -o ./merged  # 合并项目，自动解决 ID 冲突
```

### 发布

```bash
bimdown publish ./my-project          # 发布到 BimClaw并获取分享链接
```

### MEP 拓扑

```bash
bimdown resolve-topology ./my-project   # 自动检测重合端点，
                                         # 生成 mep_node，填充连接关系
```

### 同步

```bash
bimdown sync ./my-project   # 加载到 DuckDB，再写回 CSV + SVG/GeoJSON
```

## 快速一览

```
project/
  project_metadata.json         # format_version（1 = SVG，2 = GeoJSON）、项目名称、单位
  global/
    level.csv                   # 建筑楼层
    grid.csv                    # 结构轴网
  lv-1/
    wall.csv + wall.geojson     # 墙（CSV 属性 + 几何；v1 项目里是 .svg）
    door.csv                    # 门（仅 CSV，参数化定位在宿主墙上）
    slab.csv + slab.geojson     # 楼板
    space.csv                   # 房间（种子点 + 名称）
    ...
```

无论用哪种编码，CSV 属性层完全相同：

**wall.csv**
```csv
id,material,thickness
w-1,concrete,0.2
w-2,concrete,0.2
```

几何层是 GeoJSON **或** SVG 二选一：

**wall.geojson**（`format_version: 2`，默认）
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "w-1" },
      "geometry": { "type": "LineString", "coordinates": [[0,0],[10,0]] } },
    { "type": "Feature", "properties": { "id": "w-2" },
      "geometry": { "type": "LineString", "coordinates": [[10,0],[10,8]] } }
  ]
}
```

**wall.svg**（`format_version: 1`）
```xml
<svg xmlns="http://www.w3.org/2000/svg">
  <g transform="scale(1,-1)">
    <path id="w-1" d="M 0,0 L 10,0" />
    <path id="w-2" d="M 10,0 L 10,8" />
  </g>
</svg>
```

**door.csv**（两种编码下都无需几何文件 — 位置是参数化的）
```csv
id,host_id,position,width,height,operation
d-1,w-1,3.0,0.9,2.1,single_swing
```

## 定位

BimDown 是一个 **LOD 200 级别的轻量 Revit 替代方案**，面向方案设计阶段。它记录建筑构件的"是什么、在哪里、多大" — 而不是"具体怎么构造"。

适合使用 BimDown 的场景：
- AI Agent 直接读写和推理建筑数据
- **与 Revit 双向互通** — 导出、编辑（人工或 AI）、导回
- 基于 Git 的建筑模型版本控制与差异对比
- 用 SQL 查询建筑数据（通过 DuckDB）
- 设计工具之间的轻量交换格式

适合使用 Revit（或其他完整 BIM 工具）的场景：
- 施工级别的详细程度（LOD 300+）
- 多层墙体 / 楼板构造
- 结构 / 能耗分析（需要物理材料属性）
- 施工图和详图

## 格式规范

完整的格式规范在 [`spec/`](./spec/) 目录。核心概念：

- **所有坐标单位为米**，Y 轴 = 北
- **ID 按楼层隔离** — 在每个 `lv-N/` 目录内唯一
- **宿主构件**（门、窗、洞口）使用 `host_id` + `position`（距宿主墙起点的距离，单位米）
- **空间**是种子点 — 边界从周围的墙自动推导
- **材料**使用固定枚举：`concrete, steel, wood, clt, glass, aluminum, brick, stone, gypsum, insulation, copper, pvc, ceramic, fiber_cement, composite`
- **几何层**为 SVG **或** GeoJSON，由 `format_version` 选择（`1` = SVG，`2` = GeoJSON）：
  - **GeoJSON**（默认）：`Point` / `LineString` / `Polygon`（不支持 Multi\*）；支持二维和三维坐标
  - **SVG**：`<path>`（M, L, A 命令）、`<rect>`、`<circle>`、`<polygon>` — 不支持贝塞尔曲线；仅二维
- **Mesh 回退** — 任何构件可以附带可选的 `mesh_file`（GLB）用于 3D 可视化
- **MEP 拓扑** — 管线和节点组成的二部图，由 CLI 自动解析

### 构件类型

| 类别 | 构件 |
|---|---|
| 建筑 | wall, column, slab, door, window, opening, space, stair, ramp, railing, curtain_wall, ceiling, roof, room_separator |
| 结构 | structure_wall, structure_column, structure_slab, beam, brace, foundation |
| MEP | duct, pipe, cable_tray, conduit, equipment, terminal, mep_node |
| 其他 | level, grid, mesh（非参数化回退） |

## BimDown 无法表达的内容

以下 Revit 场景超出 BimDown 的范围，导出时会被转为 `mesh`（GLB 回退）或丢失：

### 几何限制
- **自由曲面 / NURBS 几何** — 概念体量、自适应族、具有复杂形状的内建族
- **非圆弧曲线墙** — 椭圆弧、样条墙（圆弧是支持的）
- **斜楼板** — 子图元形状编辑、坡度箭头、变厚度楼板
- **编辑过的墙轮廓** — 非矩形墙截面（如带坡顶的山墙）
- **幕墙单元面板细节** — 各面板材质、嵌入式门、非矩形面板

### 数据限制
- **多层构造** — 墙 / 楼板 / 屋顶的层构造（核心层、饰面层、保温层）
- **族类型与参数** — Revit 类型系统、实例参数、公式、约束
- **阶段** — 现有 / 拆除 / 新建的施工阶段
- **设计选项** — 同一模型中的备选设计方案
- **组和阵列** — 重复构件模式
- **嵌套族** — 包含其他族的族
- **工作集与链接模型** — 多用户协作、跨模型引用

### 专业限制
- **结构分析** — 荷载、边界条件、钢筋详图
- **MEP 计算** — 流量、压降、电气负荷、冷热负荷
- **能耗模型** — 热工性能（U 值、SHGC）、使用时间表（几何足够但热工属性缺失）
- **场地与地形** — 地形实体、用地红线、场地构件
- **家具与固定装置** — 导出为 `mesh`（GLB）而非参数化构件
- **视图与图纸** — 剖面、立面、详图视图、标注、尺寸、明细表

## 相关项目

- **[bimdown-editor](https://github.com/nicepkg/bimdown-editor)** — 基于浏览器的 2D/3D 建筑编辑器
- **[BimClaw](https://bim-claw.com)** — SaaS 平台，提供托管 AI Agent、实时协作和领域分析工具

## 许可证

MIT
