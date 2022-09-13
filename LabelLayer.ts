import { Feature } from 'ol';
import { getHeight, getWidth } from 'ol/extent';
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
import { getSquaredTolerance } from 'ol/renderer/vector';
import VectorSource from 'ol/source/Vector';
import { apply, compose, create, Transform } from 'ol/transform';
import ViewHint from 'ol/ViewHint';
import polylabel from 'polylabel';

type LabelProvider = (
  feature: Feature,
  label: HTMLDivElement,
  variant: string,
  frameState: FrameState
) => string | void;

export class LabelLayer extends Layer<VectorSource> {
  private labelProvider: LabelProvider;

  public constructor(
    options: Options<VectorSource> & { labelProvider: LabelProvider }
  ) {
    super(options);
    this.labelProvider = options.labelProvider;
  }

  public getLabelProvider = (): LabelProvider => this.labelProvider;

  createRenderer = (): LayerRenderer<LabelLayer> => {
    return new LabelRenderer(this);
  };
}

type CacheEntry = {
  featureRevision: number;
  geometryRevision: number;
  inacessibilityPole: [number, number];
  labels: Record<
    number,
    {
      div: HTMLDivElement;
      width: number;
      height: number;
    }
  >;
};

class LabelRenderer extends LayerRenderer<LabelLayer> {
  private container = document.createElement('div');
  private tempTransform = create();
  private features: Feature[];
  private parser = new jsts.io.OL3Parser();
  private geoJson = new GeoJSON();
  private cache = new WeakMap<Feature, CacheEntry>();

  constructor(layer: LabelLayer) {
    super(layer);
    this.container.style.position = 'absolute';
    this.container.style.width = '100%';
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
        labels: {},
      };
      this.cache.set(feature, created);
      return created;
    }
  };

  renderFeature = (
    feature: Feature,
    frameState: FrameState,
    transform: Transform,
    rotation: number
  ): void => {
    const cached = this.getCacheEntry(feature);
    // TODO When zoomin, find bigger resolution
    const resolutionCacheKey = String(
      Math.floor(frameState.viewState.resolution * 1e3)
    );
    if (cached.labels[resolutionCacheKey] === null) {
      // Known that label does not fit or is undesired.
      return;
    }
    if (cached.labels[resolutionCacheKey]) {
      const screenGeometryCenter = [...cached.inacessibilityPole];
      // TODO Apply user transformation.
      apply(transform, screenGeometryCenter);

      const labelParams = cached.labels[resolutionCacheKey];
      labelParams.div.style.left = `${
        screenGeometryCenter[0] - labelParams.width / 2
      }px`;
      labelParams.div.style.top = `${
        screenGeometryCenter[1] - labelParams.height / 2
      }px`;
      this.container.append(labelParams.div);
      return;
    }

    const geometry = feature.getGeometry();
    const squaredTolerance = getSquaredTolerance(
      frameState.viewState.resolution,
      frameState.pixelRatio
    );
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
    if (screenGeometry instanceof Polygon) {
      const label = document.createElement('div');
      label.style.position = 'absolute';
      let maxWidth = getWidth(screenGeometry.getExtent());

      let variant: string | void = 'default';
      while (variant) {
        label.style.maxWidth = `${maxWidth}px`;
        label.innerHTML = '';
        variant = this.getLayer().getLabelProvider()(
          feature,
          label,
          variant,
          frameState
        );

        if (label.childNodes.length === 0) {
          // Abort rendering, no label contents.
          cached.labels[resolutionCacheKey] = null;
          return;
        }
        this.container.append(label);

        if (label.scrollWidth > maxWidth) {
          // No valid label placement.
          cached.labels[resolutionCacheKey] = null;
          this.container.removeChild(label);
          return;
        }

        const range = new Range();
        range.selectNodeContents(label);
        let rangeRect: DOMRect;
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
          rangeRect = range.getBoundingClientRect();
          if (
            label.scrollWidth > maxWidth ||
            rangeRect.width === 0 ||
            rangeRect.width > maxWidth ||
            rangeRect.height > getHeight(screenGeometry.getExtent())
          ) {
            // No valid label placement.
            cached.labels[resolutionCacheKey] = null;
            break;
          }

          const rects: jsts.geom.Geometry[] = Array.from(
            range.getClientRects()
          ).map((rect) => {
            const envelope = new jsts.geom.Envelope(
              screenGeometryCenter[0] - rangeRect.width / 2 + rect.left,
              screenGeometryCenter[0] - rangeRect.width / 2 + rect.right,
              screenGeometryCenter[1] - rangeRect.height / 2 + rect.top,
              screenGeometryCenter[1] - rangeRect.height / 2 + rect.bottom
            );
            return screenGeometryJts.getFactory().toGeometry(envelope);
          });
          const allRects =
            rects.length > 0
              ? rects.reduce((prev, current) => prev.union(current))
              : undefined;

          if (allRects && screenGeometryJts.contains(allRects)) {
            //Found okay
            cached.labels[resolutionCacheKey] = {
              div: label,
              width: rangeRect.width,
              height: rangeRect.height,
            };
            break;
          }

          maxWidth =
            screenGeometryJts
              .intersection(allRects)
              .getEnvelopeInternal()
              .getWidth() - 20;
          label.style.maxWidth = `${maxWidth}px`;
        }
        range.detach();
        if (cached.labels[resolutionCacheKey]) {
          label.style.left = `${
            screenGeometryCenter[0] - rangeRect.width / 2
          }px`;
          label.style.top = `${
            screenGeometryCenter[1] - rangeRect.height / 2
          }px`;
          return;
        } else {
          this.container.removeChild(label);
        }
      }
    }
  };

  prepareFrame = (frameState: FrameState): boolean => {
    const userExtent = toUserExtent(
      frameState.extent,
      frameState.viewState.projection
    );
    this.features = this.getLayer().getSource().getFeaturesInExtent(userExtent);
    this.container.innerHTML = '';
    return this.features.length > 0;
  };

  renderFrame = (frameState: FrameState, target: HTMLElement): HTMLElement => {
    if (this.container.parentElement === null) {
      this.changed();
    } else {
      this.renderWorlds(frameState);
    }
    return this.container;
  };

  renderWorld = (
    frameState: FrameState,
    transform: Transform,
    rotation: number
  ) => {
    for (const feature of this.features) {
      try {
        this.renderFeature(feature, frameState, transform, rotation);
      } catch (e) {
        console.warn(
          'Failed to render ' + feature.getId() + ', skipping it.',
          e
        );
      }
    }
  };

  renderWorlds(frameState: FrameState) {
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
    do {
      const transform = this.getRenderTransform(
        center,
        resolution,
        rotation,
        width,
        height,
        world * worldWidth
      );
      this.renderWorld(frameState, transform, rotation);
    } while (++world < endWorld);
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
  getRenderTransform(center, resolution, rotation, width, height, offsetX) {
    const dx1 = width / 2;
    const dy1 = height / 2;
    const sx = 1 / resolution;
    const sy = -sx;
    const dx2 = -center[0] + offsetX;
    const dy2 = -center[1];
    return compose(this.tempTransform, dx1, dy1, sx, sy, -rotation, dx2, dy2);
  }
}
