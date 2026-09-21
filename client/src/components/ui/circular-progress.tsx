// A single "how much received/loaded" ring — one hue (blue) filled proportionally, light gray
// track for the remainder, the plain number (no "%") centered inside. Rounded stroke caps and a
// plain track/fill pair rather than a multi-color gauge, since this is one value, not a
// category breakdown. Shared by Scan Order/Master View's state column, Loading's items table,
// and Unloading's items table — one aggregate ring in each table's header, one per-row ring per
// product showing that row's own percentage.
export function CircularProgress({ percent, size = 36, strokeWidth = 4, color = "#2563eb", trackColor = "#e5e7eb", textColor }: {
  percent: number; size?: number; strokeWidth?: number; color?: string; trackColor?: string;
  // Defaults to the ring color (fine on a white row background). Headers on this app's navy
  // bar need this overridden to white — colored text on navy reads as barely-there, same
  // problem the reference "activity ring" image avoids by keeping its number white and only
  // the ring itself colored.
  textColor?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        fontSize={size * 0.32} fontWeight={700} fill={textColor ?? color}
      >
        {clamped}
      </text>
    </svg>
  );
}
