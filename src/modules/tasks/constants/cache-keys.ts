// Task cache key patterns
export const TASK_CACHE_PATTERNS = {
  SINGLE_TASK: (id: string) => `task:${id}`,
  TASK_LIST: 'tasks:*',
};