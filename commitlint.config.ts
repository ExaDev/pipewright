import { RuleConfigSeverity, type UserConfig } from "@commitlint/types";

import { commitTypeNames } from "./commit-types.ts";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [RuleConfigSeverity.Error, "always", commitTypeNames],
  },
};

export default config;
