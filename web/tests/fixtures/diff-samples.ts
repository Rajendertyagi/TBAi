/** A realistic multi-file Git-style patch used by rendering tests. */
export const prettyPatch = `diff --git a/src/hello.ts b/src/hello.ts
index 83db48f..bf269f4 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,4 +1,5 @@
 const hello = "world";
-print("hello")
+// greet loudly
+console.log("hello", hello);
 export { hello };
diff --git a/src/index.ts b/src/index.ts
index 5e1c30a..9f2c1d3 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { hello } from "./hello";
-hello();
+import { log } from "./log";
+log(hello);
`;
