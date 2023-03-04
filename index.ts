// Import stylesheets
import { Map, View } from 'ol';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import './style.css';

import {
  LinearRing,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from 'ol/geom';
import VectorLayer from 'ol/layer/Vector';
import VectorSource, { VectorSourceEvent } from 'ol/source/Vector';
import { Fill, RegularShape, Stroke, Style, Icon, Text } from 'ol/style';
import { LabelLayer } from './LabelLayer';
import { defaultOrder } from 'ol/renderer/vector';
import { OverpassSource } from './OverpassSource';
import { createXYZ } from 'ol/tilegrid';
import { tile } from 'ol/loadingstrategy';
import { transform } from 'ol/proj';
import { TileDebug } from 'ol/source';
import { BuildingTopologySource, parseLevel } from './BuildingTopologySource';
import VectorEventType from 'ol/source/VectorEventType';
import { FeatureLike } from 'ol/Feature';
import { FrameState } from 'ol/Map';
import { Transform } from 'ol/transform';
import { transform2D } from 'ol/geom/flat/transform';
import {
  elevatorIconUri,
  stairsDownIconUri,
  stairsIconUri,
  stairsUpIconUri,
  toiletsFemaleIconUri,
  toiletsIconUri,
  toiletsMaleIconUri,
} from './icons';
import { clamp } from 'ol/math';
import { OL3Parser } from 'jsts/org/locationtech/jts/io';

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

window.showInfo = (show: boolean): void => {
  document.querySelector('#info').style.display = show ? 'block' : 'none';
};
window.toggleFullscreen = (): void => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((e) => {
      console.error(e);
      alert('Fullscreen mode not permitted by browser.');
    });
  } else {
    document.exitFullscreen();
  }
};

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new OSM(),
    }),
  ],
  view: new View({
    center: transform([9.8942147, 47.9101541], 'EPSG:4326', 'EPSG:3857'),
    zoom: 16,
  }),
});
const buildingVisibilityMinZoom = 15;

let buildingOutlinesVisible = false;
window.showOutlines = (checkbox: HTMLInputElement): void => {
  buildingOutlinesVisible = checkbox.checked;
  map
    .getAllLayers()
    .filter((l) => l.getSource() instanceof VectorSource)
    .forEach((l) => l.changed());
};

let currentLevel = 0;
function isOnCurrentLevel(f: FeatureLike) {
  const level = parseLevel(f);
  return (
    level &&
    level.some(
      (fromTo) =>
        fromTo && fromTo.from <= currentLevel && fromTo.to >= currentLevel
    )
  );
}

const source = new BuildingTopologySource({
  activeLevel: currentLevel,
});
const overpassSource = new OverpassSource({
  strategy: tile(
    createXYZ({
      minZoom: 13,
      maxZoom: 13,
      tileSize: 2 * 256,
    })
  ),
});
overpassSource.addEventListener(
  VectorEventType.ADDFEATURE,
  (e: VectorSourceEvent) => {
    source.addFeature(e.feature);
  }
);
map.addLayer(
  new VectorLayer({
    source: overpassSource,
    minZoom: buildingVisibilityMinZoom,
    style: null,
  })
);
/*map.addLayer(
  new TileLayer({
    source: new TileDebug({
      tileGrid: createXYZ({
        minZoom: 13,
        maxZoom: 13,
        tileSize: 2 * 256,
      }),
    }),
  })
);*/

const levelPicker = document.getElementById('levelPicker');
const setLevel = (level: number): void => {
  Array.from(levelPicker.children).forEach((b) =>
    (b as HTMLElement).classList.remove('active')
  );
  currentLevel = level;
  source.setActiveLevel(currentLevel);
  map
    .getAllLayers()
    .filter((l) => l.getSource() instanceof VectorSource)
    .forEach((l) => l.changed());
  rerenderLevel();
};
let levelPickerUpdateTimer: number;
const updateLevelPickerAsync = () => {
  clearTimeout(levelPickerUpdateTimer);
  levelPickerUpdateTimer = setTimeout(() => {
    const viewExtent = map.getView().calculateExtent();
    const presentLevels: number[] = source.getPresentLevels(
      viewExtent,
      map.getView().getProjection(),
      (f) =>
        // Only consider features for level picker that are likely to be rendered.
        f.get('level') &&
        (f.get('generated-wall') === 'yes' ||
          ['room', 'corridor', 'area'].includes(f.get('indoor')) ||
          f.get('room') ||
          f.get('indoor') === 'stairs' ||
          f.get('stais') ||
          f.get('highway') === 'steps' ||
          f.get('name'))
    );
    levelPicker.replaceChildren([]);
    for (const level of presentLevels) {
      const button = document.createElement('button');
      button.innerText = String(level);
      button.dataset.floorLevel = String(level);
      if (level === currentLevel) {
        button.classList.add('active');
      }
      button.onclick = () => {
        setLevel(level);
      };
      levelPicker.append(button);
    }
  }, 500);
};
map.getView().addEventListener('change', updateLevelPickerAsync);
source.addEventListener('change', updateLevelPickerAsync);

const zoomCloserInfo = document.querySelector(
  '#zoomCloserInfo'
) as HTMLDivElement;
map.getView().addEventListener('change:resolution', () => {
  const showHint = map.getView().getZoom() < buildingVisibilityMinZoom;
  zoomCloserInfo.style.display = showHint ? 'block' : 'none';
});

window.showView = (select: HTMLSelectElement): void => {
  if (select.value.includes(',')) {
    const [lon, lat, zoom, level] = select.value.split(/,/).map(parseFloat);
    const center = transform([lon, lat], 'EPSG:4326', 'EPSG:3857');
    map.getView().setCenter(center);
    map.getView().setZoom(zoom);
    setLevel(level);
  } else {
    const center = map.getView().getCenter();
    const centerWorld = transform(center, 'EPSG:3857', 'EPSG:4326');
    console.log(centerWorld.concat(map.getView().getZoom()).join(','));
  }
  select.value = '';
};

const buildingStyle = [
  new Style({
    stroke: new Stroke({
      color: 'magenta',
      width: 15,
    }),
  }),
  new Style({
    stroke: new Stroke({
      color: 'white',
      width: 10,
    }),
    fill: new Fill({
      color: 'white',
    }),
  }),
];
const roomStyle = new Style({
  fill: new Fill({
    color: 'white',
  }),
});
const areaStroke = new Stroke({
  color: 'darkgray',
  lineDash: [5],
  width: 1,
});
const roomIconStyle = new Style({
  geometry: (f) => {
    const geo = f.getGeometry();
    if (geo instanceof Polygon) {
      return geo.getInteriorPoint();
    }
  },
});
const wallStyle = new Style({
  fill: new Fill({
    color: 'lightgray',
  }),
  stroke: new Stroke({
    color: 'darkgray',
    width: 2,
  }),
});
const walkwayArrowhead = new Style({
  image: null,
  text: new Text({
    fill: new Fill({
      color: 'green',
    }),
    stroke: new Stroke({
      width: 3,
      color: 'white',
    }),
  }),
});
const stairsIcon = new Icon({
  src: stairsIconUri,
});
const stairsUpIcon = new Icon({
  src: stairsUpIconUri,
});
const stairsDownIcon = new Icon({
  src: stairsDownIconUri,
});
const stairsIconStyle = new Style({
  image: null,
});
const stairsStyle = [
  new Style({
    stroke: new Stroke({
      color: 'darkgray',
      lineCap: 'butt',
    }),
  }),
  stairsIconStyle,
];

map.addLayer(
  new VectorLayer({
    source,
    minZoom: buildingVisibilityMinZoom,
    renderOrder: (f1, f2) => {
      // Draw buildings first.
      const f1Builing = f1.get('building');
      const f2Building = f2.get('building');
      if (f1Builing && !f2Building) {
        return -1;
      }
      if (!f1Builing && f2Building) {
        return 1;
      }

      // Draw walls last.
      const f1Wall = f1.get('generated-wall') === 'yes';
      const f2Wall = f2.get('generated-wall') === 'yes';
      if (f1Wall && !f2Wall) {
        return 1;
      }
      if (f2Wall && !f1Wall) {
        return -1;
      }

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
    },
    style: (f, meterPerPixel) => {
      if (f.get('building')) {
        return buildingOutlinesVisible ? buildingStyle : null;
      }

      if (!isOnCurrentLevel(f)) {
        return;
      }

      if (
        ['room', 'corridor', 'area'].includes(f.get('indoor')) ||
        f.get('room')
      ) {
        roomStyle.getFill().setColor('white');
        roomStyle.setStroke(
          f.get('indoor') === 'area' ? areaStroke : undefined
        );
        if (f.get('indoor') === 'corridor') {
          roomStyle.getFill().setColor('#dfc');
        }
        if (
          ['stairs', 'corridor', 'lobby', 'hall', 'elevator'].includes(
            f.get('room')
          ) ||
          f.get('stairs') === 'yes' ||
          f.get('highway') === 'elevator'
        ) {
          roomStyle.getFill().setColor('#dfc');
          return roomStyle;
        }
        if (['toilet', 'toilets'].includes(f.get('room'))) {
          roomStyle.getFill().setColor('lightblue');
        }

        return roomStyle;
      }
      if (f.get('generated-wall')) {
        return wallStyle;
      }
      if (f.get('generated-walkway')) {
        const geo = f.getGeometry() as LineString;
        const start = geo.getFirstCoordinate();
        const end = geo.getLastCoordinate();
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        let rotation = Math.atan2(dy, dx);
        if (rotation < 0) {
          rotation = rotation + 2 * Math.PI;
        }
        walkwayArrowhead.setGeometry(new Point(end));
        const arrowheadRadius = clamp(2 / meterPerPixel, 6, 18);
        if (
          arrowheadRadius !==
          (walkwayArrowhead.getImage() as RegularShape)?.getRadius()
        ) {
          walkwayArrowhead.setImage(
            new RegularShape({
              points: 3,
              radius: arrowheadRadius,
              displacement: [0, -1.5 * arrowheadRadius],
              fill: new Fill({
                color: 'green',
              }),
              rotateWithView: true,
            })
          );
        }
        walkwayArrowhead.getImage().setRotation(-rotation - 1.5 * Math.PI);

        const text = walkwayArrowhead.getText();
        text.setText(f.get('name'));
        text.setOffsetX(-2.5 * arrowheadRadius * Math.cos(rotation));
        text.setOffsetY(2.5 * arrowheadRadius * Math.sin(rotation));
        if (rotation >= 5.5 || rotation <= 0.79) {
          text.setTextAlign('right');
        } else if (rotation >= 0.79 && rotation <= 2.36) {
          text.setTextAlign('center');
          text.setOffsetY(1.25 * text.getOffsetY());
        } else if (rotation >= 2.36 && rotation <= 3.93) {
          text.setTextAlign('left');
        } else {
          text.setTextAlign('center');
          text.setOffsetY(1.5 * text.getOffsetY());
        }
        return [walkwayArrowhead];
      }
      if (
        f.get('indoor') === 'stairs' ||
        f.get('stais') ||
        f.get('highway') === 'steps'
      ) {
        const geo = f.getGeometry();
        if (geo instanceof LineString) {
          stairsStyle[0].getStroke().setWidth(2 / meterPerPixel);
          const stepSize = 0.3 / meterPerPixel;
          stairsStyle[0].getStroke().setLineDash([stepSize, stepSize]);

          const conveying: 'forward' | 'backward' = f.get('conveying');
          const level: string = f.get('level');
          stairsIconStyle.setGeometry(null);
          if (f.get('incline') === 'down') {
            if (level?.startsWith(currentLevel + ';')) {
              stairsIconStyle.setGeometry(new Point(geo.getLastCoordinate()));
              stairsIconStyle.setImage(
                conveying === 'forward'
                  ? null
                  : conveying === 'backward'
                  ? stairsUpIcon
                  : stairsUpIcon
              );
            } else if (level?.endsWith(';' + currentLevel)) {
              stairsIconStyle.setGeometry(new Point(geo.getFirstCoordinate()));
              stairsIconStyle.setImage(
                conveying === 'forward'
                  ? stairsDownIcon
                  : conveying === 'backward'
                  ? null
                  : stairsDownIcon
              );
            }
          } else {
            if (level?.startsWith(currentLevel + ';')) {
              stairsIconStyle.setGeometry(new Point(geo.getFirstCoordinate()));
              stairsIconStyle.setImage(
                conveying === 'forward'
                  ? stairsUpIcon
                  : conveying === 'backward'
                  ? null
                  : stairsUpIcon
              );
            } else if (level?.endsWith(';' + currentLevel)) {
              stairsIconStyle.setGeometry(new Point(geo.getLastCoordinate()));
              stairsIconStyle.setImage(
                conveying === 'forward'
                  ? null
                  : conveying === 'backward'
                  ? stairsDownIcon
                  : stairsDownIcon
              );
            }
          }
          if (map.getView().getResolution() >= 0.4) {
            stairsIconStyle.setImage(null);
          }
          return stairsStyle;
        }
      }
    },
  })
);

map.addLayer(
  new LabelLayer({
    source,
    minZoom: buildingVisibilityMinZoom,
    filter: (f) => f.get('indoor') !== 'level' && isOnCurrentLevel(f),
    occupiedSpaces: (
      world: number,
      frameState: FrameState,
      transform: Transform,
      rotation: number
    ): jsts.geom.Geometry[] => {
      return source
        .getFeaturesInExtent(frameState.extent, frameState.viewState.projection)
        .filter((f) => f.get('generated-wall') === 'yes')
        .map((wall) => {
          const screenGeometry = wall.getGeometry().clone();
          screenGeometry.applyTransform((coords, dest, dim) => {
            return transform2D(coords, 0, coords.length, dim, transform, dest);
          });
          return parser.read(screenGeometry);
        });
    },
    labelProvider: (f, label, variant) => {
      label.style.textAlign = 'center';

      const typeName: string =
        f.get('shop') || f.get('amenity') || f.get('vending');
      const name: string = f.get('name');
      const reference: string = f.get('ref');
      const shortest = [
        ['typeName', typeName],
        ['name', name],
        ['reference', reference],
      ]
        .filter(([k, v]) => Boolean(v))
        .sort((a, b) => a[1].length - b[1].length)
        .map(([k]) => k)[0];

      if (
        typeName &&
        (variant === 'default' ||
          (variant === 'shortest-only' && shortest === 'typeName'))
      ) {
        const typeNameLabel = document.createElement('div');
        typeNameLabel.style.margin = '0';
        typeNameLabel.style.fontSize = '11px';
        typeNameLabel.style.color = '#666';
        typeNameLabel.append(
          // Replace OSM values to resemble ordinary English.
          typeName.replaceAll('_', ' ').replaceAll(';', ', ')
        );
        label.append(typeNameLabel);
      }

      if (
        name &&
        (variant === 'default' ||
          (variant === 'shortest-only' && shortest === 'name'))
      ) {
        const title = document.createElement('p');
        title.style.font = 'bold 12px sans-serif';
        title.style.margin = '0';
        title.append(name);
        label.append(title);
      }
      if (
        reference &&
        (variant === 'default' ||
          (variant === 'shortest-only' && shortest === 'reference'))
      ) {
        const ref = document.createElement('p');
        ref.style.font = '12px sans-serif';
        ref.style.margin = '0';
        ref.append(reference);
        label.append(ref);
      }

      if (
        ['toilet', 'toilets'].includes(f.get('room')) ||
        f.get('amenity') === 'toilets'
      ) {
        const isMale = f.get('male') === 'yes';
        const isFemale = f.get('female') === 'yes';
        const icon = document.createElement('img');
        if (isMale && !isFemale) {
          icon.src = toiletsMaleIconUri;
        } else if (!isMale && isFemale) {
          icon.src = toiletsFemaleIconUri;
        } else {
          icon.src = toiletsIconUri;
        }
        label.prepend(icon);
        if (variant === 'icon-only') {
          return { allowExtendingGeometry: true };
        } else {
          return {
            allowExtendingGeometry: false,
            fallbackVariant: 'icon-only',
          };
        }
      } else if (label.firstElementChild) {
        const isMale = f.get('male') === 'yes';
        const isFemale = f.get('female') === 'yes';
        if (isMale && !isFemale) {
          label.firstElementChild.prepend('🚹 ');
        } else if (!isMale && isFemale) {
          label.firstElementChild.prepend('🚺 ');
        } else if (f.get('unisex') === 'yes' || (isMale && isFemale)) {
          label.firstElementChild.prepend('🚻 ');
        }
      }

      const isStairs = f.get('room') === 'stairs' || f.get('stairs') === 'yes';
      const isElevator =
        f.get('room') === 'elevator' || f.get('highway') === 'elevator';
      if ((isStairs || isElevator) && map.getView().getResolution() < 0.4) {
        const icon = document.createElement('img');
        icon.src = isStairs ? stairsIcon.getSrc() : elevatorIconUri;
        if (label.firstElementChild) {
          icon.style.marginRight = '0.5ex';
          icon.style.verticalAlign = 'middle';
          label.firstElementChild.prepend(icon);
        } else {
          label.prepend(icon);
        }
        if (variant === 'icon-only') {
          return { allowExtendingGeometry: true };
        } else {
          return {
            allowExtendingGeometry: false,
            fallbackVariant: 'icon-only',
          };
        }
      }
      if (variant === 'default' && shortest) {
        return { fallbackVariant: 'shortest-only' };
      }
    },
  })
);

rerenderLevel();

function rerenderLevel() {
  Array.from(levelPicker.children)
    .filter(
      (b) => (b as HTMLElement).dataset.floorLevel === String(currentLevel)
    )
    .forEach((b) => (b as HTMLElement).classList.add('active'));
}
