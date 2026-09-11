import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";

export const uploadsRoot = resolve(
  process.env.LOCAL_UPLOAD_DIR ?? join(process.cwd(), "../../.data/uploads"),
);

export function localObjectPath(key: string) {
  const target = resolve(uploadsRoot, ...key.split("/"));
  if (!(target === uploadsRoot || target.startsWith(`${uploadsRoot}${sep}`))) {
    throw new Error("Invalid object key");
  }
  return target;
}

export async function removeLocalObject(key: string) {
  await fs.rm(localObjectPath(key), { force: true });
}
