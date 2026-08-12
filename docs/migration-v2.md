# v2 模型配置迁移

新配置使用 `modelRoutes`。旧字段仍受支持，新字段优先。

| 旧字段 | 新字段 |
| --- | --- |
| `balatrobotProvider` | `modelRoutes.routine.provider` |
| `balatrobotModel` | `modelRoutes.routine.model` |
| `balatrobotApiBaseUrl` | `modelRoutes.routine.baseUrl` |
| `balatrobotStrategicProvider` | `modelRoutes.strategic.provider` |
| `balatrobotStrategicModel` | `modelRoutes.strategic.model` |
| `balatrobotStrategicApiBaseUrl` | `modelRoutes.strategic.baseUrl` |
| `balatrobotLocalProvider` | `modelRoutes.local.provider` |
| `balatrobotLocalModel` | `modelRoutes.local.model` |
| `provider` / `model` / `apiBaseUrl` | `modelRoutes.vision.*` |

旧 DPAPI 文件不会被删除。新安装建议运行：

```powershell
.\scripts\store-model-keys.ps1
```

它会创建语义明确的高频与战略两个凭据槽。运行脚本在使用新 `modelRoutes` 时优先加载这两个槽；旧配置继续读取旧 Kimi/DeepSeek DPAPI 路径。
