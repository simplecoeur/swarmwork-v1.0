/// <reference types="vite/client" />

/** G-05 帮助中心：仓库内 markdown 源文件随前端打包（?raw 取原文，渲染前先转义） */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
