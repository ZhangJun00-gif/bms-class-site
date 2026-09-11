import type { InjectionKey } from 'vue';

/** 返回 true 允许切换 Tab；返回 false 阻止（例如有未保存修改） */
export type AdminTabGuard = () => boolean | Promise<boolean>;

export interface AdminTabGuardRegistry {
  register(tabId: string, guard: AdminTabGuard): void;
  unregister(tabId: string): void;
}

export const adminTabGuardKey: InjectionKey<AdminTabGuardRegistry> =
  Symbol('adminTabGuard');
