import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  ...coreWebVitals,
  ...nextTypeScript,
  { ignores: [".next/**", "coverage/**", "playwright-report/**"] },
];

export default config;
