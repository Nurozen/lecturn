import type { StaticScreenProps } from "@react-navigation/native";
import { AddStaveSagaScreen, AddStaveSpaceScreen } from "./AddStaveProjectScreen";

type AddStaveProjectRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddStaveSpaceRoute({
  route,
}: StaticScreenProps<AddStaveProjectRouteParams | undefined>) {
  return <AddStaveSpaceScreen {...(route.params ?? {})} />;
}

export function AddStaveSagaRoute({
  route,
}: StaticScreenProps<AddStaveProjectRouteParams | undefined>) {
  return <AddStaveSagaScreen {...(route.params ?? {})} />;
}
