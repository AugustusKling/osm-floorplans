import { Feature } from 'ol';
import VectorSource from 'ol/source/Vector';
import {
  LineString,
  LinearRing,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from 'ol/geom';
import { Extent } from 'ol/extent';
import { Projection } from 'ol/proj';
import { FeatureLike } from 'ol/Feature';
import { squaredDistance } from 'ol/coordinate';
import { OL3Parser } from 'jsts/org/locationtech/jts/io';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope';
import { UnaryUnionOp } from 'jsts/org/locationtech/jts/operation/union';
import UnionOp from 'jsts/org/locationtech/jts/operation/union/UnionOp';
import { GeometryFactory, GeometryCollection } from 'jsts/org/locationtech/jts/geom';
import { OverlayOp } from 'jsts/org/locationtech/jts/operation/overlay';
import { BufferOp, BufferParameters } from 'jsts/org/locationtech/jts/operation/buffer';
import { RelateOp } from 'jsts/org/locationtech/jts/operation/relate';
import "jsts/org/locationtech/jts/monkey.js";

const parser = new OL3Parser();
parser.inject(
  Point,
  LineString,
  LinearRing,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon
);

class Level {
  geometry: jsts.geom.Geometry;
  features: Feature[] = [];
  outerWallWidth = 0.4;
  wallRebuildRequired = true;
  wall = new Feature({
    'generated-wall': 'yes',
  });
  unhandledEntrances: Feature[] = [];

  constructor(public levelNumber: number, seedGeometry: jsts.geom.Geometry) {
    this.wall.set('level', String(levelNumber));
    this.geometry = seedGeometry;
  }

  intersects = (geometry: jsts.geom.Geometry): boolean => {
    return (
      this.geometry
        .getEnvelopeInternal()
        .intersects(geometry.getEnvelopeInternal()) &&
      RelateOp.intersects(this.geometry, geometry)
    );
  };

  mergeIn = (other: Level): this => {
    this.geometry = UnionOp.union(this.geometry, other.geometry);
    this.features.push(...other.features);
    return this;
  };

  addFeature = (f: Feature, featureJts: jsts.geom.Geometry): void => {
    this.features.push(f);
    const geometry = f.getGeometry();
    // Level geometry is used to check for contained feature for which only areas are relevant.
    if (geometry instanceof Polygon || geometry instanceof MultiPolygon) {
      this.geometry = UnionOp.union(this.geometry,
        BufferOp.bufferOp(featureJts, this.outerWallWidth)
      );
    }
    this.wallRebuildRequired = true;

    const entrance = f.get('entrance');
    if (
      geometry instanceof Point &&
      ['yes', 'main', 'secondary', 'staircase'].includes(entrance)
    ) {
      this.unhandledEntrances.push(f);
    }
  };

  getWallSourceAreas = (): Polygon[] => {
    const polys: Polygon[] = [];
    for (const room of this.features.filter((f) =>
      f.get('indoor')==='room'
    )) {
      const roomGeo = room.getGeometry();
      if (roomGeo instanceof Polygon) {
        polys.push(roomGeo);
      } else if (roomGeo instanceof MultiPolygon) {
        polys.push(...roomGeo.getPolygons());
      }
    }
    return polys;
  };

  rebuildWall = (): void => {
    if (!this.wallRebuildRequired) {
      return;
    }

    /** Outline of walls that could have door openings. */
    const wallLines = new MultiLineString([]);
    /** Walled, passable areas. Basically rooms of any type. */
    const wallSourceAreas = new MultiPolygon([]);
    const polys = this.getWallSourceAreas();
    for (const poly of polys) {
      wallSourceAreas.appendPolygon(poly);
    }
    for (const ring of polys.flatMap((p) => p.getLinearRings())) {
      wallLines.appendLineString(new LineString(ring.getCoordinates()));
    }
    for (const wall of this.features.filter(
      (f) => f.get('indoor') === 'wall'
    )) {
      const wallGeo = wall.getGeometry();
      if (wallGeo instanceof LineString) {
        wallLines.appendLineString(wallGeo);
      }
    }

    const parser = new OL3Parser();
    parser.inject(
      Point,
      LineString,
      LinearRing,
      Polygon,
      MultiPoint,
      MultiLineString,
      MultiPolygon
    );

    let wallLinesJts = parser.read(wallLines);

    const doorCirclesCollectionJts = [];
    for (const door of this.features.filter(
      (f) => f.get('door') || f.get('indoor') === 'door' || f.get('entrance')
    )) {
      const doorGeo = door.getGeometry();
      const width = parseFloat(door.get('width'));
      const doorWidth = !isNaN(width) ? width : 1.2;
      doorCirclesCollectionJts.push(
        BufferOp.bufferOp(parser.read(doorGeo), doorWidth / 2 - 0.5)
      );
    }
    const doorCirclesJts = UnaryUnionOp.union(
      new GeometryCollection(
        doorCirclesCollectionJts,
        new GeometryFactory()
      )
    );
    /** Wall segments that are passable by doors. */
    const doorLines = OverlayOp.intersection(wallLinesJts, doorCirclesJts);
    const doorBuffersJts = BufferOp.bufferOp(
      doorLines,
      0.5,
      new BufferParameters(
        8,
        BufferParameters.CAP_SQUARE,
        BufferParameters.JOIN_MITRE,
        5
      )
    );

    const outerWallWidth = 0.4;
    const innerWallWidth = 0.2;
    // Expand walled areas to simulate thicker outer walls.
    let wallSourceAreasJts = BufferOp.bufferOp(
      parser.read(wallSourceAreas),
      outerWallWidth - innerWallWidth / 2,
      new BufferParameters(
        8,
        BufferParameters.CAP_FLAT,
        BufferParameters.JOIN_MITRE,
        5
      )
    );
    // Add floor area as it might extend the simulated area created by buffering rooms.
    const levelArea = this.features.find((f) => f.get('indoor') === 'level');
    if (levelArea) {
      wallSourceAreasJts = wallSourceAreasJts.union(
        parser.read(levelArea.getGeometry())
      );
    }
    // Cut away walkable areas to go from slab area to wall area.
    // Negative buffer to simulate inner walls between rooms.
    const walkableAreasSeparate = [
      // Walled walkable areas.
      ...wallSourceAreas.getPolygons().map((poly) => ({
        walled: true,
        poly,
        area: poly.getArea(),
      })),
      // Unwalled walkable area (since there are indoor=area occasionally outwit rooms).
      ...this.features
        .filter((f) => ['area', 'corridor'].includes(f.get('indoor')))
        .map((f) => f.getGeometry())
        .filter((geo) => geo instanceof Polygon || geo instanceof MultiPolygon)
        .map((poly) => ({
          walled: false,
          poly,
          area: (poly as Polygon | MultiPolygon).getArea(),
        })),
    ];
    // Simulate inner walls, starting from bigger area.
    walkableAreasSeparate.sort((a, b) => b.area - a.area);
    for (const walkableArea of walkableAreasSeparate) {
      const walkableAreaJts = parser.read(walkableArea.poly);
      // Add innerwall of rooms within other rooms.
      if (
        walkableArea.walled &&
        !RelateOp.contains(wallSourceAreasJts, walkableAreaJts)
      ) {
        wallSourceAreasJts = wallSourceAreasJts.union(
          BufferOp.bufferOp(
            walkableAreaJts,
            innerWallWidth / 2,
            new BufferParameters(
              8,
              BufferParameters.CAP_FLAT,
              BufferParameters.JOIN_MITRE,
              5
            )
          )
        );
      }
      // Remove walkable area.
      wallSourceAreasJts = OverlayOp.difference(wallSourceAreasJts,
        BufferOp.bufferOp(
          walkableAreaJts,
          -innerWallWidth / 2,
          new BufferParameters(
            8,
            BufferParameters.CAP_FLAT,
            BufferParameters.JOIN_MITRE,
            5
          )
        )
      );
    }
    // Add explitly drawn walls.
    for (const wall of this.features.filter(
      (f) => f.get('indoor') === 'wall'
    )) {
      const wallGeo = wall.getGeometry();
      if (wallGeo instanceof Polygon || wallGeo instanceof MultiPolygon) {
        wallSourceAreasJts = wallSourceAreasJts.union(parser.read(wallGeo));
      } else if (
        wallGeo instanceof LineString ||
        wallGeo instanceof MultiLineString
      ) {
        const wallWithThickness = BufferOp.bufferOp(
          parser.read(wallGeo),
          innerWallWidth / 2,
          new BufferParameters(
            8,
            BufferParameters.CAP_SQUARE,
            BufferParameters.JOIN_MITRE,
            5
          )
        );
        wallSourceAreasJts = wallSourceAreasJts.union(wallWithThickness);
      }
    }
    // Cut door openings in wall area.
    wallSourceAreasJts = OverlayOp.difference(wallSourceAreasJts, doorBuffersJts);

    this.wall.setGeometry(parser.write(wallSourceAreasJts));
    this.wallRebuildRequired = false;

    this.cutWallFromAreas(wallSourceAreasJts);
  };

  private cutWallFromAreas = (wallAreaJts: jsts.geom.Geometry): void => {
    for (const feature of this.features) {
      const featureGeometry = feature.getGeometry();
      if (
        featureGeometry instanceof Polygon ||
        featureGeometry instanceof MultiPolygon
      ) {
        const oldFeatureGeometryJts = parser.read(featureGeometry);
        const newFeatureGeometryJts = OverlayOp.difference(oldFeatureGeometryJts, wallAreaJts);
        feature.setGeometry(parser.write(newFeatureGeometryJts));
      }
    }
  };

  public generateEntranceWalkways = (): Feature[] => {
    const generatedWalkways: Feature[] = [];
    if (this.unhandledEntrances.length > 0) {
      const wallLines = new MultiLineString([]);
      const walledAreas = this.getWallSourceAreas();
      for (const entrance of this.unhandledEntrances) {
        const entrancePoint = entrance.getGeometry() as Point;
        for (const walledArea of walledAreas) {
          const closest = walledArea.getClosestPoint(
            entrancePoint.getFirstCoordinate()
          );
          const isClose =
            squaredDistance(entrancePoint.getFirstCoordinate(), closest) < 1;
          if (isClose) {
            const doorCircle = parser.read(entrancePoint).buffer(0.5);
            const intersections = walledArea
              .getLinearRings()
              .map((anyRing) =>
                parser.read(anyRing).intersection(doorCircle)
              )[0];
            const coords = intersections.getCoordinates();
            if (coords.length > 1) {
              const p1 = [coords[0].x, coords[0].y];
              const p2 = [
                coords[coords.length - 1].x,
                coords[coords.length - 1].y,
              ];
              const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
              const walkwayCenter = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
              const walkwayLength = 1;
              const walkwayOutside = [
                walkwayCenter[0] +
                  walkwayLength * Math.cos(angle + Math.PI / 2),
                walkwayCenter[1] +
                  walkwayLength * Math.sin(angle + Math.PI / 2),
              ];
              const walkwayEndInside = walledArea.containsXY(
                walkwayOutside[0],
                walkwayOutside[1]
              );
              if (walkwayEndInside) {
                const diffX = walkwayCenter[0] - walkwayOutside[0];
                const diffY = walkwayCenter[1] - walkwayOutside[1];
                walkwayOutside[0] = walkwayCenter[0] + 2 * diffX;
                walkwayOutside[1] = walkwayCenter[1] + 2 * diffY;
              }
              const walkway = new Feature(
                new LineString([walkwayOutside, walkwayCenter])
              );
              walkway.setProperties({
                'generated-walkway': 'yes',
                level: String(this.levelNumber),
                name: entrance.get('name'),
                entrance: entrance.get('entrance'),
              });
              this.features.push(walkway);
              generatedWalkways.push(walkway);
              break;
            }
          }
        }
      }
      this.unhandledEntrances = [];
    }
    return generatedWalkways;
  };
}

export function parseLevel(f: FeatureLike): { from: number; to: number }[] {
  const level = f.get('level');
  if (level) {
    return level
      .split(';')
      .map((fromTo) => {
        const parts = fromTo.split(/(?<!^)\s*(?<!\-)\-\s*/);
        if (parts.length === 1) {
          return { from: parseFloat(parts[0]), to: parseFloat(parts[0]) };
        } else if (parts.length === 2) {
          return { from: parseFloat(parts[0]), to: parseFloat(parts[1]) };
        } else {
          console.log(
            `Level of feature ${f.getId()} cannot be parsed: ${level}`
          );
        }
      })
      .filter(Boolean);
  }
}

export class BuildingTopologySource extends VectorSource {
  private resultingFeatures = new VectorSource();
  private levels: Level[] = [];
  private activeLevel: number;

  public constructor(options: { activeLevel: number }) {
    super({
      features: [],
    });
    this.activeLevel = options.activeLevel;
  }

  public setActiveLevel = (activeLevel: number): void => {
    this.activeLevel = activeLevel;
    this.changed();
  };

  private levelsOfFeature = (feature: Feature): number[] => {
    const level = parseLevel(feature);
    if (level) {
      return level.flatMap((l) => {
        const min = Math.min(l.from, l.to);
        const max = Math.max(l.from, l.to);
        const levels = [min];
        let current = min;
        while (current + 1 <= max) {
          current = current + 1;
          levels.push(current);
        }
        return levels;
      });
    } else {
      return [];
    }
  };

  private getLevels = (level: number, geo: jsts.geom.Geometry): Level[] => {
    const intersecting = this.levels.filter(
      (l) => l.levelNumber === level && l.intersects(geo)
    );
    if (intersecting.length > 0) {
      return intersecting;
    } else {
      const newLevel = new Level(level, geo);
      this.levels.push(newLevel);
      this.resultingFeatures.addFeature(newLevel.wall);
      return [newLevel];
    }
  };

  addFeature = (feature: Feature): void => {
    const levelNumbers = this.levelsOfFeature(feature);
    for (const levelNumber of levelNumbers) {
      const featureGeometryJts = parser.read(feature.getGeometry());
      const levels = this.getLevels(levelNumber, featureGeometryJts);
      let level: Level;
      if (levels.length > 1) {
        level = levels.reduce((a, b) => a.mergeIn(b));
        this.levels = this.levels.filter(
          (l) => !levels.includes(l) || l === level
        );
        for (const obsolteLevel of levels.filter((l) => l !== level)) {
          this.resultingFeatures.removeFeature(obsolteLevel.wall);
        }
      } else {
        level = levels[0];
      }
      level.addFeature(feature, featureGeometryJts);
    }
    this.resultingFeatures.addFeature(feature);
    this.changed();
  };

  getFeaturesInExtent = (extent: Extent, projection: Projection): Feature[] => {
    const extentJts = new Envelope(
      extent[0],
      extent[2],
      extent[1],
      extent[3]
    );
    const start = new Date().getTime();
    for (const level of this.levels) {
      const levelInView =
        level.levelNumber === this.activeLevel &&
        extentJts.intersects(level.geometry.getEnvelopeInternal());
      if (levelInView && level.wallRebuildRequired) {
        const elapsed = new Date().getTime() - start;
        if (elapsed < 100) {
          level.rebuildWall();
        } else {
          // Abort wall simulation but trigger delayed change to simulate next wall batch.
          setTimeout(() => {
            this.changed();
          }, 500);
          break;
        }
      }

      if (levelInView && level.unhandledEntrances.length > 0) {
        this.resultingFeatures.addFeatures(level.generateEntranceWalkways());
      }
    }
    return this.resultingFeatures
      .getFeaturesInExtent(extent, projection)
      .filter((f) => {
        if (f.get('building')) {
          return true;
        }
        const level = parseLevel(f);
        return (
          level &&
          level.some(
            (fromTo) =>
              fromTo &&
              fromTo.from <= this.activeLevel &&
              fromTo.to >= this.activeLevel
          )
        );
      });
  };

  getPresentLevels = (
    extent: Extent,
    projection: Projection,
    filter: (f: Feature) => boolean
  ): number[] => {
    const features = this.resultingFeatures
      .getFeaturesInExtent(extent, projection)
      .filter(filter);
    return Array.from(
      new Set(
        features.flatMap((f) => {
          const level = parseLevel(f);
          if (level) {
            return level.flatMap((l) => [l.from, l.to]);
          } else {
            return [];
          }
        })
      )
    ).sort((a, b) => a - b);
  };
}
