import { CommonActions, type NavigationState, type ParamListBase } from "@react-navigation/native";

import { uuidv4 } from "../../lib/uuid";

const NEW_TASK_FLOW_ROUTES = new Set(["NewTaskProject", "AddProject"]);

/**
 * Ends the root-stack new-task flow on a thread route: the draft it started from and every picker
 * above it leave the stack, so Back returns to where the flow began.
 */
export function replaceNewTaskFlowWithThread(
  navigation: {
    dispatch: (action: ReturnType<typeof CommonActions.reset>) => void;
    getState: () => NavigationState<ParamListBase> | undefined;
  },
  params: object,
) {
  const state = navigation.getState();
  if (!state) return;
  const threadIndex = state.routes.findLastIndex((route) => route.name === "Thread");
  const flowStart =
    threadIndex >= 0
      ? threadIndex
      : state.routes.findIndex((route) => NEW_TASK_FLOW_ROUTES.has(route.name));
  const routes = [
    ...state.routes.slice(0, flowStart < 0 ? state.index : flowStart),
    { key: uuidv4(), name: "Thread", params },
  ];
  navigation.dispatch(CommonActions.reset({ ...state, index: routes.length - 1, routes }));
}
