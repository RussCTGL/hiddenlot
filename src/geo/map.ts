import "server-only";
import { geoClipRectangle, geoMercator, geoPath } from "d3-geo";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land50m from "world-atlas/land-50m.json";

// Base map for the Today page: East and Southeast Asia in Mercator, drawn as one
// SVG path on the server from Natural Earth land polygons (public domain, via
// world-atlas). No map tiles or third-party map service are involved.

export const MAP_W = 1000;
export const MAP_H = 900;

// Wider than any port in the gazetteer, so zooming out never shows a cut coastline.
const FRAME: Feature<Polygon> = {
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[80, -12], [80, 52], [150, 52], [150, -12], [80, -12]]] }, // clockwise: the inside
};

const projection = geoMercator().fitExtent([[0, 0], [MAP_W, MAP_H]], FRAME);

let land: string | null = null;

/** The land outline as SVG path data in a MAP_W × MAP_H box (computed once per server process). */
export function landPath(): string {
  if (land === null) {
    const topo = land50m as unknown as Topology<{ land: GeometryCollection }>;
    const shapes = feature(topo, topo.objects.land) as unknown as { features: Feature<Polygon | MultiPolygon>[] };
    const path = geoPath(projection.postclip(geoClipRectangle(-10, -10, MAP_W + 10, MAP_H + 10))).digits(0);
    land = shapes.features.map((f) => path(f) ?? "").join("");
  }
  return land;
}

/** Map coordinates for a [longitude, latitude], or null when it lies outside the drawn region. */
export function project(lonlat: [number, number]): [number, number] | null {
  const [lon, lat] = lonlat;
  if (lon < 80 || lon > 150 || lat < -12 || lat > 52) return null;
  const p = projection(lonlat);
  return p ? [Math.round(p[0]), Math.round(p[1])] : null;
}
