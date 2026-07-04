/**
 * Component types are defined once at module load via defineComponent and
 * identified by a stable name so they can be serialized over the network.
 */
export interface ComponentType<T> {
  readonly id: number;
  readonly name: string;
  /** Phantom field carrying the component's data type; never set at runtime. */
  readonly _data?: T;
}

const byName = new Map<string, ComponentType<unknown>>();
const all: ComponentType<unknown>[] = [];

export function defineComponent<T>(name: string): ComponentType<T> {
  if (byName.has(name)) throw new Error(`component already defined: ${name}`);
  const type: ComponentType<T> = { id: all.length, name };
  all.push(type);
  byName.set(name, type);
  return type;
}

export function componentByName(name: string): ComponentType<unknown> | undefined {
  return byName.get(name);
}
