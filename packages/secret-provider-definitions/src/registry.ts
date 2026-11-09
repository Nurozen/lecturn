import { makeSecretProviderDefinitionRegistry } from "@lecturn/secret-provider-core/shared/definition";
import * as OnePassword from "@lecturn/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
