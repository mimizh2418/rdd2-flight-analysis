import type { Field } from './types';

/** A selectable aggregate may also have children; headings contain no field payload. */
export interface FieldNode {
  key: string;
  label: string;
  field?: Field;
  children: FieldNode[];
}

/**
 * Organize one source catalog into headings, poses, vectors, and individual components.
 * @param fields Descriptors for a single imported run; source arrays are never copied.
 * @returns A compact hierarchy in which every catalog identity occurs once, including raw source channels.
 */
export function fieldTree(fields: Field[]): FieldNode[] {
  const root: FieldNode = { key: 'root', label: '', children: [] };
  const nodes = new Map<string, FieldNode>();

  for (const field of fields) {
    // Some canonical quantities (e.g. collective thrust) have both scalar and aggregate descriptors.
    if (!nodes.has(field.id)) {
      const label =
        field.type === 'pose'
          ? 'Pose'
          : field.type === 'orientation'
            ? 'Orientation'
            : field.id.startsWith('vector:')
              ? field.label.replace(/^(Reference |Estimated )/, '').replace(' ENU', '')
              : field.label;
      nodes.set(field.id, { key: field.id, label, field, children: [] });
    }
  }
  const attached = new Set<string>();

  /**
   * Attach a catalog node under an aggregate, skipping absent or previously attached identities.
   * @param parent Destination aggregate node.
   * @param id Child's canonical identity.
   * @returns Nothing; updates the metadata tree without mutating its field descriptors.
   */
  const attach = (parent: FieldNode, id: string) => {
    const child = nodes.get(id);
    if (child && !attached.has(id) && child !== parent) {
      parent.children.push(child);
      attached.add(id);
    }
  };

  for (const node of nodes.values()) {
    const field = node.field!;
    if (field.type === 'pose') {
      attach(node, `vector:${field.prefix}`);
      if (field.orientation) attach(node, `orientation:${field.orientation}`);
    }
  }

  for (const node of nodes.values()) {
    const field = node.field!;
    if (field.type !== 'scalar' && field.type !== 'pose') {
      for (const id of field.signals) attach(node, id);
      if (field.type === 'orientation') {
        const prefix = field.prefix === 'estimate.q' ? 'estimate.rpy' : 'rpy';
        for (let axis = 0; axis < 3; axis++) attach(node, `${prefix}.${axis}`);
      }
    }
  }

  for (const node of nodes.values()) {
    if (attached.has(node.key)) continue;
    let parent = root;
    const field = node.field!;
    const path = field.group.split(' / ');
    // Pose/vector headings already carry their quantity name; avoid a redundant Position > Position layer.
    if (field.type !== 'scalar' && ['Truth', 'Reference', 'Estimator', 'Actuation'].includes(path[0])) path.length = 1;
    if (field.group === 'All source channels') {
      path.push(...field.id.split('.').slice(0, -1));
    }

    for (const label of path) {
      const key = `${parent.key}/${label}`;
      let group = parent.children.find((child) => child.key === key);
      if (!group) {
        group = { key, label, children: [] };
        parent.children.push(group);
      }
      parent = group;
    }
    parent.children.push(node);
  }
  for (const group of root.children) {
    // Put the vehicle pose first in each canonical family; expand it to find position and attitude together.
    group.children.sort((a, b) => Number(b.field?.type === 'pose') - Number(a.field?.type === 'pose'));
  }
  return root.children;
}

/**
 * Filter a field tree while preserving ancestry and expanding matches during a search.
 * @param nodes Full hierarchy for one source.
 * @param query Lowercase search text, including channel names and units.
 * @returns Filtered copies; a matching heading/aggregate includes all of its children.
 */
export function filterFieldTree(nodes: FieldNode[], query: string): FieldNode[] {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    if ((node.field?.search ?? node.label.toLowerCase()).includes(query)) return [node];
    const children = filterFieldTree(node.children, query);
    return children.length ? [{ ...node, children }] : [];
  });
}
