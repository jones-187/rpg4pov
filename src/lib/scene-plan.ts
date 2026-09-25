import type { TurnInteraction } from "./interaction-schema";
import { parsePublicScene, type PublicScene } from "./public-scene";
import { parseResponseInteraction, parseResponseStateUpdate } from "./pi-response";

/** Experimental seam: internal changes never enter the prose writer's context. */
export interface ScenePlan {
  kind: "scene";
  publicScene: PublicScene;
  visibleEvents: string[];
  stateUpdate: string;
  interaction: TurnInteraction;
}

export function parseScenePlan(raw: string): ScenePlan {
  const value = JSON.parse(raw) as Partial<Omit<ScenePlan, "stateUpdate">> & { stateUpdate?: unknown };
  if (!value || value.kind !== "scene" || Object.keys(value).some(key => !["kind", "publicScene", "visibleEvents", "stateUpdate", "interaction"].includes(key))) throw new Error("invalid scene response fields");
  if (!value || !Array.isArray(value.visibleEvents) || value.visibleEvents.length < 1 || value.visibleEvents.length > 20 ||
    value.visibleEvents.some((event) => typeof event !== "string" || !event.trim() || event.length > 2000)) {
    throw new Error("scene plan requires 1-20 visible events");
  }
  const stateUpdate = parseResponseStateUpdate(value.stateUpdate);
  const interaction = parseResponseInteraction(value.interaction);
  return { kind: "scene", publicScene: parsePublicScene(value.publicScene), visibleEvents: value.visibleEvents, stateUpdate, interaction };
}

export async function buildSceneRenderContext(_workspaceDir: string, plan: ScenePlan): Promise<string> {
  // Do not pass raw player input, world, private actors, or stateUpdate.
  // Player actions have already been resolved into observable events.
  return [
    "## 本回合公开场景（时间与地点不得擅自更改）",
    JSON.stringify(parsePublicScene(plan.publicScene)),
    "## 本回合已决定的可观察事件（按顺序表现，不改结果）",
    JSON.stringify(plan.visibleEvents),
    "## 结尾交互",
    JSON.stringify(plan.interaction),
  ].join("\n\n");
}

export const SCENE_RENDER_SYSTEM_PROMPT = `你是主角限知叙事作者，不是世界裁判。服务端只提供主角可见材料和已决定的事件。
按指定 POV 和主角声音，用对话、动作、具体心理活动表现这些事件。不得新增事件结果、秘密、人物知识、关系定案或玩家重大决定；NPC 私心不能变成主角已知事实。保持事件中的承诺、失败、物件、言行方向准确。普通接话简短，重要情绪场景给足空间，不凑字。
没有工具，禁止读取或写入文件。最终回复只允许一个完整JSON对象：{"kind":"render","output":"# 主角视窗\\n\\n限知叙事正文"}。output首行必须是 # 主角视窗，不加其他键、不加解释。`;
