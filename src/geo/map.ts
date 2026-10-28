import "server-only";
import { geoClipRectangle, geoMercator, geoPath } from "d3-geo";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land110m from "world-atlas/land-110m.json";
import land50m from "world-atlas/land-50m.json";

// Base map for the Today page: the whole world in Mercator (without the polar
// regions), drawn as one SVG path on the server from Natural Earth land polygons
// (public domain, via world-atlas). No map tiles or third-party map service are
// involved. The page frames whatever today's lots and delivery ports need.

// Mercator over 180°W–180°E, 56°S–75°N is about twice as wide as it is tall.
const SOUTH = -56;
const NORTH = 75;
export const MAP_W = 4000;

const FRAME: Feature<Polygon> = {
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[-180, SOUTH], [-180, NORTH], [180, NORTH], [180, SOUTH], [-180, SOUTH]]] }, // clockwise: the inside
};

const projection = geoMercator().fitWidth(MAP_W, FRAME);
export const MAP_H = Math.round(geoPath(projection).bounds(FRAME)[1][1]);

const cache: Partial<Record<"coarse" | "fine", string>> = {};

/**
 * The land outline as SVG path data in a MAP_W × MAP_H box (computed once per
 * server process). "coarse" (Natural Earth 1:110m, ~45 KB) is drawn with the
 * page; "fine" (1:50m, ~450 KB) is fetched once by the browser for zoomed views.
 */
export function landPath(detail: "coarse" | "fine" = "coarse"): string {
  const hit = cache[detail];
  if (hit !== undefined) return hit;
  const topo = (detail === "fine" ? land50m : land110m) as unknown as Topology<{ land: GeometryCollection }>;
  const shapes = feature(topo, topo.objects.land) as unknown as { features: Feature<Polygon | MultiPolygon>[] };
  const path = geoPath(projection.postclip(geoClipRectangle(-10, -10, MAP_W + 10, MAP_H + 10))).digits(0);
  // At whole-map scale many vertices round onto the same point; drop the repeats.
  const d = shapes.features
    .map((f) => path(f) ?? "")
    .join("")
    .replace(/L(-?\d+,-?\d+)(?=L\1(?!\d))/g, "");
  cache[detail] = d;
  return d;
}

/** Map coordinates for a [longitude, latitude], or null when it lies outside the drawn region. */
export function project(lonlat: [number, number]): [number, number] | null {
  const [lon, lat] = lonlat;
  if (lon < -180 || lon > 180 || lat < SOUTH || lat > NORTH) return null;
  const p = projection(lonlat);
  return p ? [Math.round(p[0]), Math.round(p[1])] : null;
}
