import type { Configuration } from "lint-staged";

const config: Configuration = {
  "*.{ts,json}": ["eslint --fix --max-warnings 0 --no-warn-ignored"],
};

export default config;
