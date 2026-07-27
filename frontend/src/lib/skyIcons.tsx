/**
 * Daily Reporter V3 — Sky condition icons
 *
 * Line icons for the sky-condition picker, replacing the emoji set.
 *
 * WHY NOT EMOJI: they render differently on every platform (Windows, iOS and
 * Android each ship their own art), they carry colour we do not control so they
 * fight the theme, and on a document that goes to the City they read as casual.
 * The lucide set is monochrome, so it inherits currentColor and works in both
 * themes without a second thought.
 *
 * The `emoji` field on SKY_CONDITIONS is deliberately left in place — it is
 * stored on saved reports, and stripping it would change the shape of data
 * already on disk for no benefit. It is simply no longer rendered.
 */

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudRain,
  CloudSun,
  Flame,
  Snowflake,
  Sun,
  Wind,
} from 'lucide-react';

const SKY_ICONS: Record<string, typeof Sun> = {
  clear: Sun,
  'partly-cloudy': CloudSun,
  overcast: Cloud,
  rain: CloudRain,
  drizzle: CloudDrizzle,
  fog: CloudFog,
  windy: Wind,
  hot: Flame,
  cold: Snowflake,
};

export function SkyIcon({ id, size = 15 }: { id: string; size?: number }) {
  const Icon = SKY_ICONS[id] ?? Cloud;
  return <Icon size={size} />;
}
