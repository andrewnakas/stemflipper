export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

export function Segmented<T extends string>(props: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div class="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          class="segmented__item"
          aria-pressed={props.value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
