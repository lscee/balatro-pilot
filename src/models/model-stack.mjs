import { VisionPlanner } from "./planner.mjs";
import { DynamicRoutinePlanner, RoutineBackendController } from "./routine-router.mjs";
import {
  DynamicStrategicPlanner,
  StrategicBackendController,
  strategicModeForProvider,
} from "./strategic-router.mjs";
import { plannerConfigForBackend } from "../config.mjs";

const KIMI_PROVIDERS = new Set(["kimi-chat", "kimi-platform"]);

/**
 * The single construction boundary for every model-backed component. Game
 * policy and RPC code consume this object and never load API credentials.
 */
export function createModelStack(projectRoot, config, {
  Planner = VisionPlanner,
  routineController = null,
  strategicController = null,
  credentialKeys = {},
} = {}) {
  const routineConfig = plannerConfigForBackend(config, "balatrobot");
  const localConfig = plannerConfigForBackend(config, "balatrobot-local");
  const strategicConfig = plannerConfigForBackend(config, "balatrobot-strategic");
  const visionConfig = plannerConfigForBackend(config, "vision");
  const routineKey = credentialKeys.routine ?? process.env.BALATRO_ROUTINE_API_KEY;
  const strategicKey = credentialKeys.strategic ?? process.env.BALATRO_STRATEGY_API_KEY;

  const cloudRoutinePlanner = new Planner(projectRoot, routineConfig, { apiKey: routineKey });
  const localPlanner = new Planner(projectRoot, localConfig, { apiKey: credentialKeys.local });
  routineController ??= new RoutineBackendController({
    defaultMode: config.balatrobotRoutineBackendDefault,
    ollamaBaseUrl: new URL(localConfig.apiBaseUrl).origin,
    ollamaModel: localConfig.model,
  });
  const routinePlanner = new DynamicRoutinePlanner({
    controller: routineController,
    localPlanner,
    deepseekPlanner: cloudRoutinePlanner,
  });

  const kimiStrategicConfig = KIMI_PROVIDERS.has(strategicConfig.provider)
    ? strategicConfig
    : KIMI_PROVIDERS.has(routineConfig.provider)
      ? Object.freeze({ ...strategicConfig, provider: routineConfig.provider, model: routineConfig.model, apiBaseUrl: routineConfig.apiBaseUrl })
      : null;
  const deepseekStrategicConfig = strategicConfig.provider === "deepseek-chat"
    ? strategicConfig
    : routineConfig.provider === "deepseek-chat"
      ? Object.freeze({ ...strategicConfig, provider: routineConfig.provider, model: routineConfig.model, apiBaseUrl: routineConfig.apiBaseUrl })
      : null;
  const kimiStrategicPlanner = kimiStrategicConfig ? new Planner(projectRoot, kimiStrategicConfig, {
    apiKey: KIMI_PROVIDERS.has(strategicConfig.provider) ? strategicKey : routineKey,
  }) : null;
  const deepseekStrategicPlanner = deepseekStrategicConfig ? new Planner(projectRoot, deepseekStrategicConfig, {
    apiKey: strategicConfig.provider === "deepseek-chat"
      ? strategicKey
      : routineConfig.provider === "deepseek-chat"
        ? routineKey
        : credentialKeys.deepseek ?? process.env.DEEPSEEK_API_KEY,
  }) : null;
  const availableModes = [
    kimiStrategicPlanner ? "kimi" : null,
    deepseekStrategicPlanner ? "deepseek" : null,
  ].filter(Boolean);
  strategicController ??= new StrategicBackendController({
    defaultMode: strategicModeForProvider(strategicConfig.provider),
    availableModes,
  });
  const strategicPlanner = new DynamicStrategicPlanner({
    controller: strategicController,
    kimiPlanner: kimiStrategicPlanner,
    deepseekPlanner: deepseekStrategicPlanner,
  });

  return Object.freeze({
    routinePlanner,
    strategicPlanner,
    controllers: Object.freeze({ routine: routineController, strategic: strategicController }),
    planners: Object.freeze({ cloudRoutine: cloudRoutinePlanner, local: localPlanner, kimiStrategic: kimiStrategicPlanner, deepseekStrategic: deepseekStrategicPlanner }),
    configs: Object.freeze({ routine: routineConfig, local: localConfig, strategic: strategicConfig, vision: visionConfig }),
    strategicStatus: strategicController.status({ kimiPlanner: kimiStrategicPlanner, deepseekPlanner: deepseekStrategicPlanner }),
  });
}
