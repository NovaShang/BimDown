---
name: bimdown-zh
version: 2.0.0
description: AI与建筑信息的桥梁。像写代码一样读写BIM数据！让智能体自动完成建筑建模、按图建模、工程量统计或模型审查，甚至只是为你建一栋专属的数据化房屋！
metadata:
  {
    "openclaw": {
      "emoji": "🏛️",
      "requires": {
        "bins": ["bimdown"],
        "install": { "npm": "bimdown-cli" }
      },
      "optionalEnv": ["BIMCLAW_API"],
      "network": {
        "publish": {
          "endpoint": "https://bim-claw.com/api/shares/publish",
          "method": "POST",
          "description": "可选的分享上传步骤。会将项目的 CSV/GeoJSON/GLB 打包上传到 BimClaw 并返回一个公共分享链接。匿名发布(无需账号或 token)。智能体在每个项目首次发布前必须显式获得用户授权。",
          "override": "设置 BIMCLAW_API 指向自建后端。"
        }
      }
    }
  }
---

# BimDown 智能体技能与规范

> **你的使命：** 建立 AI 智能体和建筑数据的桥梁。使用此技能，你可以像读写代码一样理解和创建建筑信息模型(BIM)。

## 环境准备

本技能依赖 `bimdown` 可执行文件(由 npm 包 `bimdown-cli` 提供)。

1. **先检查**：运行 `which bimdown` 或 `bimdown --version`。
2. **如果没有**：先向用户请求许可,再运行 `npm install -g bimdown-cli`。

你是一个在 BimDown 项目环境中运行的 AI 编程助手。BimDown 使用 **CSV 存储属性**、**GeoJSON 存储几何**。

## 核心架构

- **单位是米**：所有坐标和尺寸必须使用米。
- **CSV 存属性**(material、thickness、尺寸、外键、枚举)；**GeoJSON 存几何**(Point / LineString / Polygon),并通过可选的 properties 携带数值几何提示(`base_offset`、`top_offset`、`arc`、`rotation`)。
- **计算字段只读**：`length`、`area`、`height`、`start_x/y/z`、`end_x/y/z`、`x`、`y`、`rotation`、`points`、`volume`、`bbox_*`、`level_id` 都由 CLI 自动计算,**任何文件都不要写入**。
- **CSV 行与 GeoJSON Feature 通过 `id` 关联**(GeoJSON 中通过 `properties.id`)。
- **`format_version: 2`**(写在 `project_metadata.json` 里)。旧 SVG 项目(v1)必须先用 `svg-to-geojson` 脚本迁移。

## 项目目录结构

```
project/
  project_metadata.json       # { "format_version": 2, "units": "m", ... }
  global/                     # 跨楼层引用与多层几何
    level.csv                 # 楼层标高(Z 的真值源)
    grid.csv                  # 结构轴网(内联坐标)
    wall.geojson + wall.csv   # 多层墙
    pipe.geojson + pipe.csv   # 立管
    ...
  lv-1/                       # 单层元素文件
    wall.csv + wall.geojson
    column.csv + column.geojson
    slab.csv + slab.geojson
    door.csv                  # 宿主元素:仅 CSV(host_id + position)
    window.csv                # 仅 CSV
    space.csv                 # 仅种子点(边界由 build 自动生成)
    ...
  lv-2/
    ...
```

**分区规则**：
- 元素的 `base_level_id` **始终等于其所在目录的层级**。跨层元素(例如跨 lv-1→lv-3 的墙)必须放到 `global/`。
- 空间(spatial)元素(梁、坡道、风管、水管…)放在它主要归属的楼层目录里。只有真正跨多层的实例(立管、跨多层楼梯)放 `global/`。

## Z 轴处理(重要 —— 仔细阅读)

按元素本性分两种模式：

### Level-anchored 元素(wall、column、slab、ceiling、roof、curtain_wall、room_separator)

- GeoJSON `geometry.coordinates` 是 **2D** `[x, y]`,不含 Z。
- `base_level_id`、`top_level_id` 在 **CSV** 中(FK)。默认值:base 取目录层级,top 取下一层。
- 数值 Z 偏移(可选,缺省 0)放在 **GeoJSON `properties`**:`base_offset`、`top_offset`。
- 好处:改 `level.csv` 中的标高,所有锚定元素自动更新。AI 不需要做任何标高算术。

### Spatial 元素(beam、brace、stair、ramp、railing、duct、pipe、cable_tray、conduit、equipment、terminal、mep_node)

- GeoJSON `geometry.coordinates` 是 **3D** `[x, y, z]`,Z 为绝对值(米)。
- `base_level_id`(CSV)仍然记录用于分区,但几何本身在 3D 中自洽。

## GeoJSON 几何参考

每个 Feature 必须有 `properties.id`,与配对的 CSV 行一致。

### 规范形式(canonical)

```jsonc
// 直墙(level-anchored,2D)
{
  "type": "Feature",
  "properties": { "id": "w-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0], [5, 0]] }
}

// 弧形墙:两端点 + arc 属性
{
  "type": "Feature",
  "properties": { "id": "w-2", "arc": { "radius": 3, "large_arc": false, "sweep": true } },
  "geometry": { "type": "LineString", "coordinates": [[5, 0], [5, 6]] }
}

// 柱子(level-anchored Point;截面属性在 CSV 里)
{
  "type": "Feature",
  "properties": { "id": "c-1" },
  "geometry": { "type": "Point", "coordinates": [2, 2] }
}

// 梁(spatial 3D LineString)
{
  "type": "Feature",
  "properties": { "id": "bm-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0, 3.5], [10, 5, 3.7]] }
}

// 楼板(2D Polygon,闭合环;厚度、材质在 CSV)
{
  "type": "Feature",
  "properties": { "id": "sl-1" },
  "geometry": { "type": "Polygon", "coordinates": [[[0,0],[10,0],[10,8],[0,8],[0,0]]] }
}
```

### AI 写法灵活,build 自动归一化

你可以用以下任意形式书写,`bimdown build` 会自动归一化:

| 你写的形式 | build 行为 |
|---|---|
| 弧形墙用 N 段折线(`LineString` 多于 3 点且共圆) | 检测出弧 → 输出两端点 + `properties.arc` |
| 矩形柱写成 4 顶点 Polygon | 提取 `shape/size_x/size_y` 到 CSV、`rotation` 到 properties;几何归一为 Point |
| 圆柱写成正多边形(N≥8 顶点共圆) | 提取 `shape="round"`、尺寸;几何归一为 Point |
| Polygon 环未闭合 | 自动闭合 |
| Level-anchored 元素写了 3D 坐标且 Z 恒定 | 丢 Z;若 Z ≠ `base_level.elevation + base_offset`,则反算 `base_offset` |

## 推荐工作流

1. **先规划空间布局**:思考墙位置、房间相邻关系、开洞。
2. **写 GeoJSON 几何**:创建 `*.geojson` Feature 集合,坐标正确。
3. **写 CSV 属性**:material、thickness、size_x/y 等。永远不要写计算字段。
4. **render 并目视检查**:`bimdown render <dir> -l lv-1 -o render.png`,看 PNG。渲染输出必须保存在**项目目录外**。
5. **build**:`bimdown build <dir>` —— 校验 schema、snap 端点、几何归一化、空间边界计算。
6. **迭代**到 render 正确。

## CLI 工具

1. **`bimdown query <dir> <sql> [--json]`** —— DuckDB SQL 查询,含 hydrate 后的几何字段。
2. **`bimdown render <dir> [-l level] [-o out.png] [-w width]`** —— 渲染单层为 PNG/SVG 图。
3. **`bimdown build <dir>`** —— 校验 + snap 端点 + 几何归一化 + 计算空间边界。**每次编辑后必跑**。
4. **`bimdown schema [table]`** —— 打印表的完整 schema。
5. **`bimdown diff <dirA> <dirB>`** —— 项目结构差异。
6. **`bimdown init <dir>`** —— 创建空项目(`format_version: 2`)。
7. **`bimdown publish <dir>`** —— 上传到 BimClaw,返回分享链接(联网,**事先征求用户同意**)。
8. **`bimdown info <dir>`** —— 各层级元素数量统计。
9. **`bimdown resolve-topology <dir>`** —— 自动解析 MEP 曲线连接关系。
10. **`bimdown merge <dirs...> -o <out>`** —— 合并多个项目。
11. **`bimdown sync <dir>`** —— 灌入 DuckDB 后再写回文件(应用归一化)。

## 发布与数据上传

`bimdown publish` 是本技能中**唯一**会联网的命令。运行前向用户确认:

- **目的地**:`https://bim-claw.com/api/shares/publish`(可用 `--api` 或 `BIMCLAW_API` 覆盖)。
- **上传内容**:整个项目打包(所有 CSV、所有 GeoJSON、任何 GLB、`project_metadata.json`)。
- **匿名**:无账号;服务器返回随机分享 token。任何持链人都可在过期前(默认 7 天)查看和下载。
- **同意要求**:每个项目**首次发布前**必须显式得到用户许可,不要自主上传。

## 关键规则

- **ID 格式**:`{prefix}-{n}`(纯数字)适用于多数元素;`lv-{any}` / `gr-{any}` 适用于 level/grid。
- **GeoJSON 坐标系**:项目局部米制坐标,`+X=东`,`+Y=北`,`+Z=上`。**不要写 `crs` 字段**,**不要做 `scale(1,-1)` 翻转** —— GeoJSON 原生 Y 向上。
- **CSV vs 计算字段**:只写非计算字段。**绝对不要写** `length`、`area`、`start_x/y/z`、`end_x/y/z`、`x`、`y`、`rotation`、`points`、`height`、`volume`、`bbox_*`、`level_id`。
- **GeoJSON properties vs CSV**:
  - `id` —— 两边都有(字符串相等匹配)。
  - `base_offset`、`top_offset`、`arc`、`rotation`、`height_offset`(ceiling)—— **GeoJSON `properties`** 里。
  - `base_level_id`、`top_level_id`、`host_id`、`position`、所有材质/尺寸/枚举属性 —— **CSV** 里。

## 生成建议

### 典型值(米)
| 元素 | 字段 | 范围 |
|---|---|---|
| 隔墙 | thickness | 0.1 – 0.15 |
| 外墙 | thickness | 0.2 – 0.3 |
| 结构墙 | thickness | 0.3 – 0.6 |
| 单开门 | width × height | 0.9 × 2.1 |
| 双开门 | width × height | 1.8 × 2.1 |
| 窗 | width × height | 1.2–1.8 × 1.5 |
| 窗台高 | `properties.base_offset` | 0.9(常规)、0(落地) |
| 柱 | size_x × size_y | 0.3–0.6 × 0.3–0.6 |
| 楼板 | thickness | 0.15 – 0.25 |
| 层高 | elevation Δ | 3.0 – 4.0 |

### 房间边界连通性
要让 `build` 能正确计算空间:
- 线元素端点必须在共享坐标处相遇(build 在 10cm 内会自动 snap)。
- `bimdown build` 会对未连通的端点发出警告,并基于闭合环计算空间面。

### 门窗位置
门窗依附在墙上,**没有 GeoJSON 文件** —— 只在 CSV 中通过 `host_id` + `position`(墙起点到开洞中心的距离,米)定位。

```csv
id,host_id,position,width,height,operation,material
d-1,w-3,1.5,0.9,2.1,single_swing,wood
```

校验规则:
- `position - width/2 >= 0` 且 `position + width/2 <= wall_length`
- 同一墙上的多个开洞不能重叠

### GeoJSON 文件模板
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "w-1" },
      "geometry": { "type": "LineString", "coordinates": [[0,0],[5,0]] } }
  ]
}
```

## 基础 schema 速查

所有元素继承自 `element`:
- **CSV**:`id`(必填)、`number`、`mesh_file`。
- **GeoJSON properties**:`base_offset`(缺省 0)。
- **计算字段**:`level_id`、`volume`、`bbox_*`。

**几何基类**(全部计算字段):
- `line_element`(wall、beam、…):`start_x`、`start_y`、`end_x`、`end_y`、`length`。
- `spatial_line_element`(beam、duct、…):再加 `start_z`、`end_z`。
- `point_element`(column、equipment、…):`x`、`y`、`rotation`。
- `polygon_element`(slab、roof、…):`points`、`area`。

**vertical_span**:
- **CSV**:`base_level_id`、`top_level_id`。
- **GeoJSON properties**:`top_offset`(缺省 0)。
- **计算**:`height`。

**hosted_element**:`host_id`、`position` —— 都在 CSV,没有 GeoJSON 文件。

**材质枚举**:concrete、steel、wood、clt、glass、aluminum、brick、stone、gypsum、insulation、copper、pvc、ceramic、fiber_cement、composite。

## 可用表

`beam`、`brace`、`cable_tray`、`ceiling`、`column`、`conduit`、`curtain_wall`、`door`、`duct`、`equipment`、`foundation`、`grid`、`level`、`mep_node`、`mesh`、`opening`、`pipe`、`railing`、`ramp`、`roof`、`room_separator`、`slab`、`space`、`stair`、`structure_column`、`structure_slab`、`structure_wall`、`terminal`、`wall`、`window`。

需要某表完整 schema 时执行 `bimdown schema <table_name>`。

## 参考 SOP

**动手前必读对应 SOP**:
- **从设计任务书出发设计建筑** → [`references/building-design.md`](./references/building-design.md)
- **按图建模(已有平面图/草图/尺寸)** → [`references/bim-modeling.md`](./references/bim-modeling.md)

## 更多资源

更多细节或与 Revit 互转的工具,请参考官方仓库:
**[https://github.com/NovaShang/BimDown](https://github.com/NovaShang/BimDown)**
