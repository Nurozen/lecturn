import type { StaticScreenProps } from "@react-navigation/native";
import {
  AddProjectImportFoldersScreen,
  AddProjectImportSessionsScreen,
} from "./AddProjectImportScreen";

type AddProjectImportFoldersRouteParams = {
  readonly environmentId?: string | string[];
};

type AddProjectImportSessionsRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly cwd?: string | string[];
};

export function AddProjectImportFoldersRoute({
  route,
}: StaticScreenProps<AddProjectImportFoldersRouteParams | undefined>) {
  return <AddProjectImportFoldersScreen {...(route.params ?? {})} />;
}

export function AddProjectImportSessionsRoute({
  route,
}: StaticScreenProps<AddProjectImportSessionsRouteParams | undefined>) {
  return <AddProjectImportSessionsScreen {...(route.params ?? {})} />;
}
