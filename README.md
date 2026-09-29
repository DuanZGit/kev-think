# kev-think

让 [Kev-4B](https://siliconflow.cn) 接管 pi 的「思考强度」的最小扩展。

两件事，都只碰思考强度，不碰模型、不碰工具集、不碰其他设置：

1. **每轮开口前问 Kev-4B 一个三档问题**（这活要不要深想），按分数定档。
   置信度够就照它说的做；不够就往上升一档；超时/无 key/任何异常 → 什么都不做。
2. **轮内失败升档**（纯规则、零 token）。同一轮连续真失败 N 次才升档。
   「真失败」= 工具报错；超时和后端忙（429/502/503/529）不算。

第 1 件每次约 100–160 tokens（Kev-4B 免费期至 2026-10-08）。第 2 件不花钱。

## 安装

pi 的扩展是**路径数组**，不是 npm 包。所以只有两个文件要落盘。

### 1. 放文件

```bash
mkdir -p ~/.pi/agent/local-ext/kev-think
curl -fsSL https://raw.githubusercontent.com/DuanZGit/kev-think/main/index.ts \
  -o ~/.pi/agent/local-ext/kev-think/index.ts
```

### 2. 在 `settings.json` 里注册

编辑 `~/.pi/agent/settings.json`，把路径加进已有的 `extensions` 数组（**别新建一个 `extensions` 键**，会覆盖你原来的配置）：

```json
{
  "extensions": [
    "~/.pi/agent/local-ext/kev-think"
  ]
}
```

### 3. 配 key

扩展找 SiliconFlow key 有两条路，任选其一。

```bash
# 方式 A：环境变量
export SILICONFLOW_KEY=sk-xxxx

# 方式 B：文件
mkdir -p ~/.secrets
echo 'SILICONFLOW_KEY=sk-xxxx' >> ~/.secrets/siliconflow.env
chmod 600 ~/.secrets/siliconflow.env
```

### 4. 新开会话

改配置和 key **都必须新开会话才生效**。新会话底部出现 kev-think 的档位显示就算装好了。

## 环境变量开关

全部需要新开会话。

| 变量 | 默认 | 作用 |
|---|---|---|
| `KEV_THINK` | 开 | `off` = 全关 |
| `KEV_THINK_ESCALATE` | 开 | `off` = 只关失败升档 |
| `KEV_THINK_AFTER` | `2` | 连续失败几次才升档 |
| `KEV_THINK_CEILING` | `high` | 升档终点 |
| `KEV_SKIP_MODELS` | 空 | 额外跳过这些模型，逗号分隔 |

## 排错

**装完没反应、也不报错** —— 这是本扩展最常见的「假成功」，因为它所有异常路径都静默降级。最可能是 key 没读到：确认 `SILICONFLOW_KEY` 环境变量真的 export 了，或者 `~/.secrets/siliconflow.env` 里的行首就是 `SILICONFLOW_KEY=`（有空格、带 `export ` 前缀都不行）。

**看日志确认到底有没有调用**：检查 `~/logs/kev-think/<日期>.jsonl`。文件不存在 = 扩展根本没跑起来，多半是第 2 步的 settings.json 没生效或者路径写错了。

**某模型报 400、错误里提到 `reasoning_effort`** —— 上游渠道不认这个档位。先把这个模型加进 `KEV_SKIP_MODELS`，扩展就不会再动它的档位。注意本扩展的档位阶梯刻意不含 `minimal` 和 `off`，因为至少两类渠道会直接 400，别自行加回去。

**某模型报 400、错误里提到 `Reasoning is mandatory` / `requires adaptive thinking`** —— 这类是模型强制推理、要的是 `models.json` 侧配置（`thinkingLevelMap: {off: null}` + `compat.forceAdaptiveThinking: true`），不是本扩展的问题。同样用 `KEV_SKIP_MODELS` 让扩展绕开它。

**Cost 好像变高了** —— 每轮多一次 Kev-4B 调用，约 100–160 tokens。`KEV_THINK=off` 全关。

## 档位阶梯说明

`LADDER = low / medium / high / xhigh / max`。

pi 自己的七档里有 `minimal` 和 `off`，但上游渠道不认：有的端点 `reasoning_effort` 白名单不含它们，有的端点强制推理、完全不接受关闭。pi 又没有「该模型支持哪些等级」的字段，设之前无法预知。地板设在 `low` 能一次避开整类问题：非推理模型会被 pi 自动夹成 off，强制推理模型接受 low 作为最低档。

## License

MIT
