/**
 * WorkBuddy session-init 层统一 export。
 *
 * ⚠️ 独立性铁律：本 barrel 只对外暴露 workbuddy 自己的类型与入口；不再re-export
 * 其他 client 的 session-init 内容。caller（workbuddyHandler）从此处一次拿到
 * 所有必要接口。
 */

export {
  handleWorkbuddySessionInit,
  type WorkbuddySessionInitResult,
  type WorkbuddyRequestContext,
} from "./init.js";
