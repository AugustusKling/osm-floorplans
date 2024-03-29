import { geom } from 'jsts';
import { Feature } from 'ol';
import { Coordinate } from 'ol/coordinate';
import { getHeight, getWidth } from 'ol/extent';
import { FeatureLike } from 'ol/Feature';
import { GeoJSON } from 'ol/format';
import {
  LineString,
  LinearRing,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from 'ol/geom';
import { transform2D } from 'ol/geom/flat/transform';
import { Layer } from 'ol/layer';
import { Options } from 'ol/layer/Layer';
import { FrameState } from 'ol/Map';
import {
  getTransformFromProjections,
  getUserProjection,
  toUserExtent,
} from 'ol/proj';
import LayerRenderer from 'ol/renderer/Layer';
import { defaultOrder } from 'ol/renderer/vector';
import VectorSource from 'ol/source/Vector';
import { apply, compose, create, Transform } from 'ol/transform';
import ViewHint from 'ol/ViewHint';
import polylabel from 'polylabel';
import { OL3Parser } from 'jsts/org/locationtech/jts/io';
import { Geometry as jstsGeometry, Point as jstsPoint, Coordinate as jstsCoordinate, Envelope as jstsEnvelope} from 'jsts/org/locationtech/jts/geom';
import { AffineTransformation } from 'jsts/org/locationtech/jts/geom/util';

type LabelProvider = (
  /** Feature to be labelled. */
  feature: Feature,
  /** Label box to be filled. */
  label: HTMLDivElement,
  /** 'default' followed by fallback variant name from previous calls. */
  variant: string,
  frameState: FrameState
) => LabelPlacementOptions | void;

export class LabelLayer extends Layer<VectorSource> {
  private labelProvider: LabelProvider;
  private filter: (f: FeatureLike) => boolean;
  private occupiedSpaces: (
    world: number,
    frameState: FrameState,
    transform: Transform,
    rotation: number
  ) => jstsGeometry[];

  public constructor(
    options: Options<VectorSource> & {
      labelProvider: LabelProvider;
      filter?: (f: FeatureLike) => boolean;
      occupiedSpaces?: typeof this.occupiedSpace;
    }
  ) {
    super(options);
    this.labelProvider = options.labelProvider;
    this.filter = options.filter || (() => true);
    this.occupiedSpaces = options.occupiedSpaces || (() => []);
  }

  public getLabelProvider = (): LabelProvider => this.labelProvider;
  public getFilter = (): ((f: FeatureLike) => boolean) => this.filter;
  public getOccupiedSpaces = (): typeof this.occupiedSpaces =>
    this.occupiedSpaces;

  createRenderer = (): LayerRenderer<LabelLayer> => {
    return new LabelRenderer(this);
  };

  public renderOrder = (f1: Feature, f2: Feature) => {
    const g1 = f1.getGeometry();
    const g1Area = g1 instanceof Polygon || g1 instanceof MultiPolygon;
    const g2 = f2.getGeometry();
    const g2Area = g2 instanceof Polygon || g2 instanceof MultiPolygon;
    if (g1Area && !g2Area) {
      return -1;
    }
    if (g2Area && !g1Area) {
      return 1;
    }
    // Draw smaller areas last.
    if (g1Area && g2Area) {
      return g2.getArea() - g1.getArea();
    }

    return defaultOrder(f1, f2);
  };
}

type LabelParam = {
  /** Label box containing multiple text boxes and possibly whitespace around. */
  div: HTMLDivElement;
  /** Text boxes, relative to inacessibility pole in screen coordinates. */
  shape: jstsGeometry;
  /** Width of label box. */
  width: number;
  /** Height of label box. */
  height: number;
};

type CacheEntry = {
  featureRevision: number;
  geometryRevision: number;
  inacessibilityPole: [number, number];
  labels: LabelParam[];
};

type LabelPlacementOptions = {
  fallbackVariant?: string;
  allowExtendingGeometry?: boolean;
};

class LabelRenderer extends LayerRenderer<LabelLayer> {
  private container = document.createElement('div');
  private tempTransform = create();
  private features: Feature[];
  private parser = new OL3Parser();
  private geoJson = new GeoJSON();
  private cache = new WeakMap<Feature, CacheEntry>();
  private occupiedSpaces: jstsGeometry[] = [];
  private occupiedByLabels: jstsGeometry[] = [];

  constructor(layer: LabelLayer) {
    super(layer);
    this.container.style.position = 'absolute';
    this.container.style.width = '200%';
    this.container.style.height = '100%';
    this.container.style.pointerEvents = 'none';

    this.parser.inject(
      Point,
      LineString,
      LinearRing,
      Polygon,
      MultiPoint,
      MultiLineString,
      MultiPolygon
    );
  }

  private getCacheEntry = (feature: Feature): CacheEntry => {
    const geometry = feature.getGeometry();

    const existing = this.cache.get(feature);
    const featureRevision = feature.getRevision();
    const geometryRevision = geometry.getRevision();
    if (
      existing?.featureRevision === featureRevision &&
      existing?.geometryRevision === geometryRevision
    ) {
      return existing;
    } else {
      const created: CacheEntry = {
        featureRevision,
        geometryRevision,
        inacessibilityPole: undefined,
        labels: [],
      };
      this.cache.set(feature, created);
      return created;
    }
  };

  renderFeature = (
    feature: Feature,
    frameState: FrameState,
    transform: Transform,
    world: number,
    rotation: number
  ): HTMLElement => {
    let geometry = feature.getGeometry();
    if (geometry instanceof MultiPolygon) {
      let biggestArea = 0;
      for (const poly of geometry.getPolygons()) {
        const area = poly.getArea();
        if (area > biggestArea) {
          biggestArea = area;
          geometry = poly;
        }
      }
    }
    if (!(geometry instanceof Point || geometry instanceof Polygon)) {
      // Other types not supported by code below.
      return;
    }

    const cached = this.getCacheEntry(feature);
    const resolutionCacheKey =
      2 * Math.floor(frameState.viewState.zoom) +
      (Math.ceil(frameState.viewState.zoom * 10) % 10 >= 5 ? 1 : 0);
    if (cached.labels[resolutionCacheKey] === null) {
      // Known that label does not fit or is undesired.
      return;
    }
    if (cached.labels[resolutionCacheKey]) {
      const screenGeometryCenter = [...cached.inacessibilityPole];
      // TODO Apply user transformation.
      apply(transform, screenGeometryCenter);

      const labelParams = cached.labels[resolutionCacheKey];
      if (this.tryOccupy(screenGeometryCenter, labelParams, true)) {
        const labelDiv =
          world === 0
            ? labelParams.div
            : (labelParams.div.cloneNode(true) as HTMLDivElement);
        labelDiv.style.left = `${
          screenGeometryCenter[0] - labelParams.width / 2
        }px`;
        labelDiv.style.top = `${
          screenGeometryCenter[1] - labelParams.height / 2
        }px`;
        this.container.append(labelDiv);
        return labelDiv;
      } else {
        // Cannot use cached placement due to intersections
        return;
      }
    }

    const userProjection = getUserProjection();
    const userTransform = userProjection
      ? getTransformFromProjections(
          userProjection,
          frameState.viewState.projection
        )
      : undefined;
    const screenGeometry = geometry.clone();
    // TODO Simplification disable as it leads to invalid geometries in some cases.
    //.simplifyTransformed(squaredTolerance, userTransform);
    screenGeometry.applyTransform((coords, dest, dim) => {
      return transform2D(coords, 0, coords.length, dim, transform, dest);
    });

    if (screenGeometry instanceof Point) {
      const screenGeometryJts = this.parser.read(
        screenGeometry
      ) as jstsPoint;
      cached.inacessibilityPole = (geometry as Point).getCoordinates() as [
        number,
        number
      ];
      const screenGeometryCenter = screenGeometry.getFirstCoordinate();
      // Arbitrary.
      let maxWidth = 500;
      const label = document.createElement('div');
      label.style.position = 'absolute';

      let variant: string | void = 'default';
      while (variant) {
        label.innerHTML = '';
        const placementOptions = this.getLayer().getLabelProvider()(
          feature,
          label,
          variant,
          frameState
        );
        variant = placementOptions ? placementOptions.fallbackVariant : null;
        const allowExtendingGeometry = placementOptions
          ? placementOptions.allowExtendingGeometry
          : false;

        if (label.childNodes.length === 0) {
          // Abort rendering, no label contents.
          cached.labels[resolutionCacheKey] = null;
          return;
        }
        this.container.append(label);

        if (!allowExtendingGeometry && label.scrollWidth > maxWidth) {
          // No valid label placement.
          cached.labels[resolutionCacheKey] = null;
          this.container.removeChild(label);
          continue;
        }

        const range = new Range();
        for (let i = 0; i < 10; i++) {
          const rangeRectsJts = this.getRectsJts(
            screenGeometryJts,
            label,
            range
          );

          if (
            allowExtendingGeometry ||
            (rangeRectsJts &&
              !this.intersectsOccupiedSpaces(rangeRectsJts, false))
          ) {
            //Found okay
            const maybeLastCandidate = cached.labels[resolutionCacheKey];
            const newLabelWidth = rangeRectsJts
              .getEnvelopeInternal()
              .getWidth();
            const newLabelHeight = rangeRectsJts
              .getEnvelopeInternal()
              .getHeight();
            const newLabelRatio = newLabelWidth / newLabelHeight;
            const oldLabelRatio = maybeLastCandidate
              ? maybeLastCandidate.width / maybeLastCandidate.height
              : null;
            if (
              oldLabelRatio === null ||
              // 2.3 is arbitrary but looks nice.
              (newLabelRatio < oldLabelRatio && newLabelRatio > 2.3)
            ) {
              cached.labels[resolutionCacheKey] = {
                div: label.cloneNode(true) as HTMLDivElement,
                shape: AffineTransformation.translationInstance(
                  -screenGeometryCenter[0],
                  -screenGeometryCenter[1]
                ).transform(rangeRectsJts),
                width: newLabelWidth,
                height: newLabelHeight,
              };
            } else if (oldLabelRatio !== null) {
              break;
            }
          }

          maxWidth = rangeRectsJts.getEnvelopeInternal().getWidth() - 50;
          if (
            maxWidth < 30 &&
            cached.labels[resolutionCacheKey] === undefined
          ) {
            // Arbitry minimum size not reached.
            cached.labels[resolutionCacheKey] = null;
            return;
          }
          label.style.width = `${maxWidth}px`;
        }
        range.detach();
        const labelParams = cached.labels[resolutionCacheKey];
        const envelope =
          labelParams &&
          this.tryOccupy(screenGeometryCenter, labelParams, false);
        if (envelope) {
          label.style.width = labelParams.div.style.width;
          label.style.left = `${
            screenGeometryJts.getX() - labelParams.width / 2
          }px`;
          label.style.top = `${
            screenGeometryJts.getY() - labelParams.height / 2
          }px`;
          return label;
        } else {
          cached.labels[resolutionCacheKey] = null;
          this.container.removeChild(label);
        }
      }
    }

    if (screenGeometry instanceof Polygon) {
      let maxWidth = Math.floor(getWidth(screenGeometry.getExtent()));
      if (maxWidth < 30) {
        // Arbitry minimum size not reached.
        cached.labels[resolutionCacheKey] = null;
        return;
      }
      const label = document.createElement('div');
      label.style.position = 'absolute';

      let variant: string | void = 'default';
      while (variant) {
        label.style.width = `${maxWidth}px`;
        label.innerHTML = '';
        const placementOptions = this.getLayer().getLabelProvider()(
          feature,
          label,
          variant,
          frameState
        );
        variant = placementOptions ? placementOptions.fallbackVariant : null;
        const allowExtendingGeometry = placementOptions
          ? placementOptions.allowExtendingGeometry
          : false;

        if (label.childNodes.length === 0) {
          // Abort rendering, no label contents.
          cached.labels[resolutionCacheKey] = null;
          return;
        }
        this.container.append(label);

        if (!allowExtendingGeometry && label.scrollWidth > maxWidth) {
          // No valid label placement.
          cached.labels[resolutionCacheKey] = null;
          this.container.removeChild(label);
          continue;
        }

        const range = new Range();
        cached.inacessibilityPole =
          cached.inacessibilityPole ||
          (polylabel(
            this.geoJson.writeGeometryObject(geometry).coordinates
          ) as [number, number]);
        const screenGeometryCenter = [...cached.inacessibilityPole];
        // TODO Apply user transformation.
        apply(transform, screenGeometryCenter);
        const screenGeometryJts = this.parser.read(screenGeometry);
        for (let i = 0; i < 10; i++) {
          const rangeRectsJts = this.getRectsJts(
            screenGeometryJts
              .getFactory()
              .createPoint(
                new jstsCoordinate(
                  screenGeometryCenter[0],
                  screenGeometryCenter[1]
                )
              ),
            label,
            range
          );
          const rangeRect = rangeRectsJts.getEnvelopeInternal();
          if (
            !allowExtendingGeometry &&
            (label.scrollWidth - 2 > maxWidth ||
              rangeRect.getWidth() === 0 ||
              rangeRect.getHeight() > getHeight(screenGeometry.getExtent()))
          ) {
            // No valid label placement.
            cached.labels[resolutionCacheKey] = null;
            break;
          }

          if (
            allowExtendingGeometry ||
            (rangeRectsJts &&
              screenGeometryJts.contains(rangeRectsJts) &&
              !this.intersectsOccupiedSpaces(rangeRectsJts, false))
          ) {
            //Found okay
            const shiftToGeometryCenter =
              AffineTransformation.translationInstance(
                -screenGeometryCenter[0],
                -screenGeometryCenter[1]
              );
            cached.labels[resolutionCacheKey] = {
              div: label,
              shape: shiftToGeometryCenter.transform(rangeRectsJts),
              width: maxWidth,
              height: rangeRect.getHeight(),
            };
            break;
          }

          maxWidth = Math.min(
            maxWidth - 1,
            Math.floor(
              screenGeometryJts
                .intersection(rangeRectsJts)
                .getEnvelopeInternal()
                .getWidth()
            ) - 1
          );
          label.style.width = `${maxWidth}px`;
        }
        range.detach();
        const labelParams = cached.labels[resolutionCacheKey];
        const envelope =
          labelParams &&
          this.tryOccupy(screenGeometryCenter, labelParams, false);
        if (envelope) {
          label.style.left = `${envelope.getMinX()}px`;
          label.style.top = `${envelope.getMinY()}px`;
          return label;
        } else {
          cached.labels[resolutionCacheKey] = null;
          this.container.removeChild(label);
        }
      }
    }
  };

  private intersectsOccupiedSpaces = (
    geo: jstsGeometry,
    checkOnlyLabels: boolean
  ): boolean => {
    const blockedRegions = [this.occupiedByLabels];
    if (!checkOnlyLabels) {
      blockedRegions.push(this.occupiedSpaces);
    }

    const geoExtent = geo.getEnvelopeInternal();
    for (const blocked of blockedRegions) {
      for (const occupiedSpace of blocked) {
        if (
          occupiedSpace.getEnvelopeInternal().intersects(geoExtent) &&
          occupiedSpace.intersects(geo)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  private tryOccupy(
    center: Coordinate,
    labelParams: LabelParam,
    checkOnlyLabels: boolean
  ): jstsEnvelope {
    const shiftToGeometryCenter =
      AffineTransformation.translationInstance(
        center[0],
        center[1]
      );
    const labelGeom = shiftToGeometryCenter.transform(labelParams.shape);
    if (!this.intersectsOccupiedSpaces(labelGeom, checkOnlyLabels)) {
      this.occupiedByLabels.push(labelGeom);
      return new jstsEnvelope(
        center[0] - labelParams.width / 2,
        center[0] + labelParams.width / 2,
        center[1] - labelParams.height / 2,
        center[1] + labelParams.height / 2
      );
    }
  }

  private getRects(element: HTMLElement, range: Range): DOMRect[] {
    const rects: DOMRect[] = [];
    for (const child of element.childNodes) {
      if (child instanceof Text) {
        range.selectNodeContents(child);
        rects.push(...range.getClientRects());
      } else if (child instanceof HTMLImageElement) {
        rects.push(child.getBoundingClientRect());
      } else if (child instanceof HTMLElement) {
        rects.push(...this.getRects(child, range));
      }
    }
    return rects;
  }

  private getRectsJts = (
    centerAroundJts: jstsPoint,
    element: HTMLElement,
    range: Range
  ): jstsGeometry => {
    const domRects = this.getRects(element, range);
    const rects: jstsGeometry[] = domRects.map((rect) => {
      const envelope = new jstsEnvelope(
        rect.left,
        rect.right,
        rect.top,
        rect.bottom
      );
      return centerAroundJts.getFactory().toGeometry(envelope);
    });
    const allRects =
      rects.length > 0
        ? rects.reduce((prev, current) => prev.union(current))
        : undefined;
    const center = centerAroundJts.getCoordinate();
    const envelope = allRects.getEnvelopeInternal();
    const envelopeCenter = envelope.centre();
    return AffineTransformation.translationInstance(
      center.x - envelopeCenter.x,
      center.y - envelopeCenter.y
    ).transform(allRects);
  };

  prepareFrame = (frameState: FrameState): boolean => {
    const userExtent = toUserExtent(
      frameState.extent,
      frameState.viewState.projection
    );
    this.features = this.getLayer()
      .getSource()
      .getFeaturesInExtent(userExtent)
      .filter((f) => this.getLayer().getFilter()(f));
    this.features.sort(this.getLayer().renderOrder);
    if (this.features.length === 0) {
      this.container.innerHTML = '';
      return false;
    } else {
      return true;
    }
  };

  renderFrame = (frameState: FrameState, target: HTMLElement): HTMLElement => {
    if (this.container.parentElement === null) {
      this.changed();
    } else {
      this.occupiedSpaces = this.forEachWorld(
        frameState,
        this.getLayer().getOccupiedSpaces()
      ).flatMap((g) => g);
      this.occupiedByLabels = [];
      const labels = this.renderWorlds(frameState);
      this.container.replaceChildren(...labels);
    }
    return this.container;
  };

  renderWorld = (
    world: number,
    frameState: FrameState,
    transform: Transform,
    rotation: number
  ): HTMLElement[] => {
    const presentLabels: HTMLElement[] = [];
    for (const feature of this.features) {
      try {
        const label = this.renderFeature(
          feature,
          frameState,
          transform,
          world,
          rotation
        );
        if (label) {
          presentLabels.push(label);
        }
      } catch (e) {
        console.warn(
          'Failed to render ' + feature.getId() + ', skipping it.',
          e
        );
      }
    }
    return presentLabels;
  };

  renderWorlds(frameState: FrameState): HTMLElement[] {
    const presentLabels: HTMLElement[] = [];
    for (const worldLabels of this.forEachWorld(frameState, this.renderWorld)) {
      presentLabels.push(...worldLabels);
    }
    return presentLabels;
  }

  private forEachWorld<X>(
    frameState: FrameState,
    mapper: (
      world: number,
      frameState: FrameState,
      transform: Transform,
      rotation: number
    ) => X
  ): X[] {
    const extent = frameState.extent;
    const viewState = frameState.viewState;
    const center = viewState.center;
    const resolution = viewState.resolution;
    const projection = viewState.projection;
    const rotation = viewState.rotation;
    const projectionExtent = projection.getExtent();
    const vectorSource = this.getLayer().getSource();
    const viewHints = frameState.viewHints;
    const snapToPixel = !(
      viewHints[ViewHint.ANIMATING] || viewHints[ViewHint.INTERACTING]
    );
    const width = Math.round(frameState.size[0]);
    const height = Math.round(frameState.size[1]);

    const multiWorld = vectorSource.getWrapX() && projection.canWrapX();
    const worldWidth = multiWorld ? getWidth(projectionExtent) : null;
    const endWorld = multiWorld
      ? Math.ceil((extent[2] - projectionExtent[2]) / worldWidth) + 1
      : 1;
    let world = multiWorld
      ? Math.floor((extent[0] - projectionExtent[0]) / worldWidth)
      : 0;
    const presentLabels: X[] = [];
    do {
      const transform = this.getRenderTransform(
        center,
        resolution,
        rotation,
        width,
        height,
        world * worldWidth
      );
      presentLabels.push(mapper(world, frameState, transform, rotation));
    } while (++world < endWorld);
    return presentLabels;
  }

  /**
   * Creates a transform for rendering to an element that will be rotated after rendering.
   * @param {import("../../coordinate.js").Coordinate} center Center.
   * @param {number} resolution Resolution.
   * @param {number} rotation Rotation.
   * @param {number} width Width of the rendered element (in pixels).
   * @param {number} height Height of the rendered element (in pixels).
   * @param {number} offsetX Offset on the x-axis in view coordinates.
   * @protected
   * @return {!import("../../transform.js").Transform} Transform.
   */
  getRenderTransform(
    center: Coordinate,
    resolution: number,
    rotation: number,
    width: number,
    height: number,
    offsetX: number
  ): Transform {
    const dx1 = width / 2;
    const dy1 = height / 2;
    const sx = 1 / resolution;
    const sy = -sx;
    const dx2 = -center[0] + offsetX;
    const dy2 = -center[1];
    return compose(this.tempTransform, dx1, dy1, sx, sy, -rotation, dx2, dy2);
  }
}
