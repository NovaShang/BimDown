import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getDrawingFields } from '../model/drawingSchema.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { Icon } from './Icons.tsx';

export default function DrawingPropertiesBar() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const target = state.drawingTarget;
  if (!target) return null;

  const fields = getDrawingFields(target.tableName);
  if (fields.length === 0) return null;

  const style = LAYER_STYLES[target.tableName];
  const disciplineColor = DISCIPLINE_COLORS[target.discipline] || '#888';
  const attrs = state.drawingAttrs;

  const handleChange = (key: string, value: string) => {
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...attrs, [key]: value } });
  };

  return (
    <div className="drawing-props-bar" style={{ '--dp-color': disciplineColor } as React.CSSProperties}>
      <span className="dp-label" style={{ color: disciplineColor, display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Icon name={target.tableName} width={16} height={16} /> {style?.displayName || target.tableName}
      </span>
      <div className="dp-separator" />
      {fields.map(f => (
        <div key={f.key} className="dp-field">
          <label className="dp-field-label">{f.label}</label>
          {f.type === 'select' && f.options ? (
            <select
              className="dp-input dp-select"
              value={attrs[f.key] ?? ''}
              onChange={e => handleChange(f.key, e.target.value)}
            >
              {f.options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : f.type === 'number' ? (
            <div className="dp-number-wrap">
              <input
                className="dp-input dp-number"
                type="number"
                value={attrs[f.key] ?? ''}
                min={f.min}
                max={f.max}
                step={f.step}
                onChange={e => handleChange(f.key, e.target.value)}
              />
              {f.unit && <span className="dp-unit">{f.unit}</span>}
            </div>
          ) : (
            <input
              className="dp-input dp-text"
              type="text"
              value={attrs[f.key] ?? ''}
              placeholder={f.label}
              onChange={e => handleChange(f.key, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
