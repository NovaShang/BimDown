import { useState } from 'react';
import type { CsvRow } from '../types.ts';
import { LAYER_STYLES } from '../types.ts';
import { useEditorDispatch } from '../state/EditorContext.tsx';

interface FloatingPropertiesProps {
  selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>;
}

const PROPERTY_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Identity', keys: ['id', 'number', 'name'] },
  { label: 'Geometry', keys: ['base_offset', 'top_offset', 'height', 'width', 'thickness', 'size_x', 'size_y', 'shape', 'start_z', 'end_z', 'length', 'area'] },
  { label: 'Material', keys: ['material', 'function'] },
  { label: 'Relationships', keys: ['host_id', 'top_level_id', 'start_node_id', 'end_node_id'] },
  { label: 'System', keys: ['system_type', 'equipment_type', 'terminal_type', 'operation'] },
];

export default function FloatingProperties({ selectedData }: FloatingPropertiesProps) {
  const dispatch = useEditorDispatch();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (selectedData.size === 0) return null;

  // Show first selected element's data
  const [firstId, firstData] = selectedData.entries().next().value!;
  const style = LAYER_STYLES[firstData.tableName];
  const csv = firstData.csv;

  // Group properties
  const grouped: { label: string; props: [string, string][] }[] = [];
  const usedKeys = new Set<string>();

  for (const group of PROPERTY_GROUPS) {
    const props: [string, string][] = [];
    for (const key of group.keys) {
      if (csv[key] !== undefined && csv[key] !== '') {
        props.push([key, csv[key]]);
        usedKeys.add(key);
      }
    }
    if (props.length > 0) {
      grouped.push({ label: group.label, props });
    }
  }

  // Other properties
  const otherProps: [string, string][] = [];
  for (const [key, value] of Object.entries(csv)) {
    if (!usedKeys.has(key) && value !== '') {
      otherProps.push([key, value]);
    }
  }
  if (otherProps.length > 0) {
    grouped.push({ label: 'Other', props: otherProps });
  }

  const toggleGroup = (label: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div className="floating-properties">
      {/* Header */}
      <div className="fp-header">
        <div className="fp-title">
          <span className="fp-type-icon" style={{ color: style?.color }}>{style?.icon || '◻'}</span>
          <span className="fp-type-name">{style?.displayName || firstData.tableName}</span>
          <span className="fp-id">{firstId}</span>
        </div>
        <button className="fp-close" onClick={() => dispatch({ type: 'CLEAR_SELECTION' })}>×</button>
        {selectedData.size > 1 && (
          <div className="fp-multi-hint">{selectedData.size} elements selected</div>
        )}
      </div>

      {/* Property groups */}
      <div className="fp-body">
        {grouped.map(group => {
          const isCollapsed = collapsed.has(group.label);
          return (
            <div key={group.label} className="fp-group">
              <button className="fp-group-header" onClick={() => toggleGroup(group.label)}>
                <span className="fp-expand">{isCollapsed ? '▸' : '▾'}</span>
                {group.label}
              </button>
              {!isCollapsed && (
                <div className="fp-group-body">
                  {group.props.map(([key, value]) => (
                    <div key={key} className="fp-row">
                      <span className="fp-key">{formatKey(key)}</span>
                      <span className="fp-value">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\bid\b/g, 'ID').replace(/\b\w/g, c => c.toUpperCase());
}
