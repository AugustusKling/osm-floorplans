import { Feature } from 'ol';
import { Coordinate } from 'ol/coordinate';
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
  labels: {
    div: HTMLDivElement;
    width: number;
    height: number;
  }[];
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
      let maxWidth = Math.floor(getWidth(screenGeometry.getExtent()));

      let variant: string | void = 'default';
      while (variant) {
        label.style.width = `${maxWidth}px`;
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
          continue;
        }

        const range = new Range();
        let rangeRect: jsts.geom.Envelope;
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
          const domRects = this.getRects(label, range);
          rangeRect = new jsts.geom.Envelope();
          for (const r of domRects) {
            rangeRect.expandToInclude(r.left, r.top);
            rangeRect.expandToInclude(r.right, r.bottom);
          }
          if (
            label.scrollWidth - 2 > maxWidth ||
            rangeRect.getWidth() === 0 ||
            rangeRect.getHeight() > getHeight(screenGeometry.getExtent())
          ) {
            // No valid label placement.
            cached.labels[resolutionCacheKey] = null;
            break;
          }

          const rects: jsts.geom.Geometry[] = domRects.map((rect) => {
            const envelope = new jsts.geom.Envelope(
              screenGeometryCenter[0] - maxWidth / 2 + rect.left,
              screenGeometryCenter[0] - maxWidth / 2 + rect.right,
              screenGeometryCenter[1] - rangeRect.getHeight() / 2 + rect.top,
              screenGeometryCenter[1] - rangeRect.getHeight() / 2 + rect.bottom
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
              width: maxWidth,
              height: rangeRect.getHeight(),
            };
            break;
          }

          maxWidth =
            Math.floor(
              screenGeometryJts
                .intersection(allRects)
                .getEnvelopeInternal()
                .getWidth()
            ) - 1;
          label.style.width = `${maxWidth}px`;
        }
        range.detach();
        if (cached.labels[resolutionCacheKey]) {
          const labelParams = cached.labels[resolutionCacheKey];
          label.style.left = `${
            screenGeometryCenter[0] - labelParams.width / 2
          }px`;
          label.style.top = `${
            screenGeometryCenter[1] - labelParams.height / 2
          }px`;
          return label;
        } else {
          this.container.removeChild(label);
        }
      }
    }
  };

  private getRects(element: HTMLElement, range: Range): DOMRect[] {
    const rects: DOMRect[] = [];
    for (const child of element.childNodes) {
      if (child instanceof Text) {
        range.selectNodeContents(child);
        rects.push(...range.getClientRects());
      } else if (child instanceof HTMLElement) {
        rects.push(...this.getRects(child, range));
      }
    }
    return rects;
  }

  prepareFrame = (frameState: FrameState): boolean => {
    const userExtent = toUserExtent(
      frameState.extent,
      frameState.viewState.projection
    );
    this.features = this.getLayer().getSource().getFeaturesInExtent(userExtent);
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
    const presentLabels: HTMLElement[] = [];
    do {
      const transform = this.getRenderTransform(
        center,
        resolution,
        rotation,
        width,
        height,
        world * worldWidth
      );
      presentLabels.push(
        ...this.renderWorld(world, frameState, transform, rotation)
      );
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
