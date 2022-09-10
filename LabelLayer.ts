import { Feature } from 'ol';
import { getHeight, getWidth } from 'ol/extent';
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
import { compose, create, Transform } from 'ol/transform';
import ViewHint from 'ol/ViewHint';

type LabelProvider = (
  feature: Feature,
  label: HTMLDivElement,
  frameState: FrameState
) => void;

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

class LabelRenderer extends LayerRenderer<LabelLayer> {
  private container = document.createElement('div');
  private tempTransform = create();
  private features: Feature[];
  private parser = new jsts.io.OL3Parser();

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

  renderFeature = (
    feature: Feature,
    frameState: FrameState,
    transform: Transform,
    rotation: number
  ): void => {
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
    const screenGeometry = geometry
      .clone()
      .simplifyTransformed(squaredTolerance, userTransform);
    screenGeometry.applyTransform((coords, dest, dim) => {
      return transform2D(coords, 0, coords.length, dim, transform, dest);
    });
    if (screenGeometry instanceof Polygon) {
      const screenGeometryCenter = screenGeometry
        .getInteriorPoint()
        .getCoordinates();
      const label = document.createElement('div');
      label.style.position = 'absolute';
      let maxWidth = getWidth(screenGeometry.getExtent());
      label.style.maxWidth = `${maxWidth}px`;
      this.getLayer().getLabelProvider()(feature, label, frameState);
      if (label.childNodes.length === 0) {
        // Abort rendering, no label contents.
        return;
      }
      this.container.append(label);

      const range = new Range();
      range.selectNodeContents(label);
      let rangeRect: DOMRect;
      const screenGeometryJts = this.parser.read(screenGeometry);
      let foundPlacement = false;
      for (let i = 0; i < 10; i++) {
        rangeRect = range.getBoundingClientRect();
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
          foundPlacement = true;
          break;
        }
        if (
          rangeRect.width === 0 ||
          rangeRect.width > maxWidth ||
          rangeRect.height > getHeight(screenGeometry.getExtent())
        ) {
          // No valid label placement.
          break;
        }

        maxWidth = screenGeometryJts
          .intersection(allRects)
          .getEnvelopeInternal()
          .getWidth();
        label.style.maxWidth = `${maxWidth}px`;
      }
      range.detach();
      if (foundPlacement) {
        label.style.left = `${screenGeometryCenter[0] - rangeRect.width / 2}px`;
        label.style.top = `${screenGeometryCenter[1] - rangeRect.height / 2}px`;
      } else {
        this.container.removeChild(label);
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
    this.renderWorlds(frameState);
    return this.container;
  };

  renderWorld = (
    frameState: FrameState,
    transform: Transform,
    rotation: number
  ) => {
    for (const feature of this.features) {
      this.renderFeature(feature, frameState, transform, rotation);
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
    const pixelRatio = frameState.pixelRatio;
    const viewHints = frameState.viewHints;
    const snapToPixel = !(
      viewHints[ViewHint.ANIMATING] || viewHints[ViewHint.INTERACTING]
    );
    const width = Math.round(frameState.size[0] * pixelRatio);
    const height = Math.round(frameState.size[1] * pixelRatio);

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
        pixelRatio,
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
   * @param {number} pixelRatio Pixel ratio.
   * @param {number} width Width of the rendered element (in pixels).
   * @param {number} height Height of the rendered element (in pixels).
   * @param {number} offsetX Offset on the x-axis in view coordinates.
   * @protected
   * @return {!import("../../transform.js").Transform} Transform.
   */
  getRenderTransform(
    center,
    resolution,
    rotation,
    pixelRatio,
    width,
    height,
    offsetX
  ) {
    const dx1 = width / 2;
    const dy1 = height / 2;
    const sx = pixelRatio / resolution;
    const sy = -sx;
    const dx2 = -center[0] + offsetX;
    const dy2 = -center[1];
    return compose(this.tempTransform, dx1, dy1, sx, sy, -rotation, dx2, dy2);
  }
}
