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
import { Fill, RegularShape, Stroke, Style, Icon } from 'ol/style';
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

const parser = new jsts.io.OL3Parser();
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

let buildingOutlinesVisible = true;
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
const stairsUpArrowhead = new Style({
  image: new RegularShape({
    points: 3,
    radius: 5,
    fill: new Fill({
      color: 'black',
    }),
    rotateWithView: true,
  }),
});
const stairsIcon = new Icon({
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCAtMjkwLjY1KSI+PHJlY3Qgc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiNmZmY7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOiNhOWE5YTk7c3Ryb2tlLXdpZHRoOi4yNjQ1ODMzMjtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIHdpZHRoPSI2LjA4NSIgaGVpZ2h0PSI2LjA4NSIgeD0iLjEzMiIgeT0iMjkwLjc4MiIgcnk9IjAiLz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6IzAwMDtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6Ljc5Mzc1MDA1O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOnJvdW5kO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgZD0iTTEuMDU4IDI5NC42MTloLjUyOXYxLjMyM2gtLjUyOXoiLz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6IzAwMDtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6Ljc5Mzc0OTk5O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOnJvdW5kO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgdHJhbnNmb3JtPSJyb3RhdGUoLTkwKSIgZD0iTS0yOTIuNTAyIDMuOTY5aC41Mjl2MS44NTJoLS41Mjl6TS0yOTMuODI1IDIuMzgxaC41Mjl2Mi4zODFoLS41Mjl6TS0yOTUuMTQ4Ljc5NGguNTI5djIuMzgxaC0uNTI5eiIvPjxwYXRoIHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojMDAwO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDouNzkzNzUwMDU7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiBkPSJNMi42NDYgMjkzLjI5NmguNTI5djEuODUyaC0uNTI5ek00LjIzMyAyOTEuOTczaC41Mjl2MS44NTJoLS41Mjl6Ii8+PC9nPjwvc3ZnPg==',
});
const stairsUpIcon = new Icon({
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PGRlZnM+PG1hcmtlciBvcmllbnQ9ImF1dG8iIHJlZlk9IjAiIHJlZlg9IjAiIGlkPSJhIiBzdHlsZT0ib3ZlcmZsb3c6dmlzaWJsZSI+PHBhdGggZD0ibTUuNzcgMC04LjY1IDVWLTVsOC42NSA1eiIgc3R5bGU9ImZpbGwtcnVsZTpldmVub2RkO3N0cm9rZTojMDAwO3N0cm9rZS13aWR0aDoxcHQ7c3Ryb2tlLW9wYWNpdHk6MTtmaWxsOiMwMDA7ZmlsbC1vcGFjaXR5OjEiIHRyYW5zZm9ybT0ic2NhbGUoLjQpIi8+PC9tYXJrZXI+PC9kZWZzPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiPjxyZWN0IHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojZmZmO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTojYTlhOWE5O3N0cm9rZS13aWR0aDouMjY0NTgzMzI7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiB3aWR0aD0iNi4wODUiIGhlaWdodD0iNi4wODUiIHg9Ii4xMzIiIHk9IjI5MC43ODIiIHJ5PSIwIi8+PHBhdGggc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiMwMDA7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOm5vbmU7c3Ryb2tlLXdpZHRoOi43OTM3NTAwNTtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIGQ9Ik0xLjMyMyAyOTUuNDEyaC41Mjl2MS4zMjNoLS41Mjl6Ii8+PHBhdGggc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiMwMDA7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOm5vbmU7c3Ryb2tlLXdpZHRoOi43OTM3NDk5OTtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIHRyYW5zZm9ybT0icm90YXRlKC05MCkiIGQ9Ik0tMjkzLjI5NiA0LjIzM2guNTI5djEuODUyaC0uNTI5ek0tMjk0LjYxOSAyLjY0NmguNTI5djIuMzgxaC0uNTI5ek0tMjk1Ljk0MiAxLjA1OGguNTI5djIuMzgxaC0uNTI5eiIvPjxwYXRoIHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojMDAwO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDouNzkzNzUwMDU7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiBkPSJNMi45MSAyOTQuMDloLjUyOXYxLjg1MkgyLjkxek00LjQ5OCAyOTIuNzY3aC41Mjl2MS44NTJoLS41Mjl6Ii8+PHBhdGggc3R5bGU9ImZpbGw6bm9uZTtmaWxsLXJ1bGU6ZXZlbm9kZDtzdHJva2U6IzAwMDtzdHJva2Utd2lkdGg6LjUyOTE2Njc7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46bWl0ZXI7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLW9wYWNpdHk6MTttYXJrZXItZW5kOnVybCgjYSkiIGQ9Im0uNjM5IDI5NC4zOTQgMi4xNS0yLjE1Ii8+PC9nPjwvc3ZnPg==',
});
const stairsDownIcon = new Icon({
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PGRlZnM+PG1hcmtlciBvcmllbnQ9ImF1dG8iIHJlZlk9IjAiIHJlZlg9IjAiIGlkPSJhIiBzdHlsZT0ib3ZlcmZsb3c6dmlzaWJsZSI+PHBhdGggZD0ibTUuNzcgMC04LjY1IDVWLTVsOC42NSA1eiIgc3R5bGU9ImZpbGwtcnVsZTpldmVub2RkO3N0cm9rZTojMDAwO3N0cm9rZS13aWR0aDoxcHQ7c3Ryb2tlLW9wYWNpdHk6MTtmaWxsOiMwMDA7ZmlsbC1vcGFjaXR5OjEiIHRyYW5zZm9ybT0ic2NhbGUoLS40KSIvPjwvbWFya2VyPjwvZGVmcz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwIC0yOTAuNjUpIj48cmVjdCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6I2ZmZjtmaWxsLW9wYWNpdHk6MTtzdHJva2U6I2E5YTlhOTtzdHJva2Utd2lkdGg6LjI2NDU4MzMyO3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOnJvdW5kO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgd2lkdGg9IjYuMDg1IiBoZWlnaHQ9IjYuMDg1IiB4PSIuMTMyIiB5PSIyOTAuNzgyIiByeT0iMCIvPjxwYXRoIHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojMDAwO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDouNzkzNzUwMDU7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiBkPSJNMS4zMjMgMjk1LjQxMmguNTI5djEuMzIzaC0uNTI5eiIvPjxwYXRoIHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojMDAwO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDouNzkzNzQ5OTk7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiB0cmFuc2Zvcm09InJvdGF0ZSgtOTApIiBkPSJNLTI5My4yOTYgNC4yMzNoLjUyOXYxLjg1MmgtLjUyOXpNLTI5NC42MTkgMi42NDZoLjUyOXYyLjM4MWgtLjUyOXpNLTI5NS45NDIgMS4wNThoLjUyOXYyLjM4MWgtLjUyOXoiLz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6IzAwMDtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6Ljc5Mzc1MDA1O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOnJvdW5kO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgZD0iTTIuOTEgMjk0LjA5aC41Mjl2MS44NTJIMi45MXpNNC40OTggMjkyLjc2N2guNTI5djEuODUyaC0uNTI5eiIvPjxwYXRoIHN0eWxlPSJmaWxsOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7c3Ryb2tlOiMwMDA7c3Ryb2tlLXdpZHRoOi41MjkxNjY3O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOm1pdGVyO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1vcGFjaXR5OjE7bWFya2VyLXN0YXJ0OnVybCgjYSkiIGQ9Im0xLjUwNCAyOTMuMzE4IDIuMTUtMi4xNSIvPjwvZz48L3N2Zz4=',
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
  /*new Style({
    stroke: new Stroke({
      color: 'black',
      width: 1,
    }),
  }),
  stairsUpArrowhead,*/ stairsIconStyle,
];

const elevatorIconUri =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCAtMjkwLjY1KSI+PHJlY3Qgc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiNmZmY7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOiNhOWE5YTk7c3Ryb2tlLXdpZHRoOi4yNjQ1ODMzMjtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIHdpZHRoPSI2LjA4NSIgaGVpZ2h0PSI2LjA4NSIgeD0iLjEzMiIgeT0iMjkwLjc4MiIgcnk9IjAiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxLjgxOCAtLjMzOCkiPjxyZWN0IHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojMDAwO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTojMDAwO3N0cm9rZS13aWR0aDouNTI5MTY2NztzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjptaXRlcjtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIHdpZHRoPSIxLjMyMyIgaGVpZ2h0PSIxLjMyMyIgeD0iMjA5LjY4OSIgeT0iMjA1LjI2OCIgcnk9IjAiIHRyYW5zZm9ybT0icm90YXRlKDQ1KSIvPjxwYXRoIHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojZmZmO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDouNTI5MTY2NjQ7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiBkPSJNMi4xNSAyOTQuMDloMi4zODF2LjUyOUgyLjE1eiIvPjwvZz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6IzAwMDtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6LjUyOTE2NjY0O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOm1pdGVyO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgZD0iTTIuOTEgMjkzLjk3MWguNTI5di43OTRIMi45MXoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEuOCAtLjM1KSIvPjxyZWN0IHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDpub25lO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTojMDAwO3N0cm9rZS13aWR0aDouNTI5MTY2NztzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIHdpZHRoPSIyLjY0NiIgaGVpZ2h0PSI0LjIzMyIgeD0iMS4wNTgiIHk9IjI5MS45NzMiIHJ4PSIuNTI5IiByeT0iLjUyOSIvPjxwYXRoIHN0eWxlPSJvcGFjaXR5OjE7ZmlsbDojMDAwO2ZpbGwtb3BhY2l0eToxO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDouNTI5MTY2NjQ7c3Ryb2tlLWxpbmVjYXA6YnV0dDtzdHJva2UtbGluZWpvaW46bWl0ZXI7c3Ryb2tlLW1pdGVybGltaXQ6NDtzdHJva2UtZGFzaGFycmF5Om5vbmU7c3Ryb2tlLWRhc2hvZmZzZXQ6MDtzdHJva2Utb3BhY2l0eToxIiBkPSJNMi4xMTcgMjkxLjIxNGguNTI5di43OTRoLS41Mjl6Ii8+PHBhdGggc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiNhOWE5YTk7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOm5vbmU7c3Ryb2tlLXdpZHRoOi41MjkxNjY2NDtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjptaXRlcjtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIGQ9Ik02LjA4NSAyOTAuNjVoLjI2NVYyOTdoLS4yNjV6Ii8+PC9nPjwvc3ZnPg==';

const toiletsIconUri =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PHBhdGggc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiNmZmY7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOiNhOWE5YTk7c3Ryb2tlLXdpZHRoOi4yNjQ1ODMzMjtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIGQ9Ik0uMTMyIDI5MC43ODJoNi4wODZ2Ni4wODZILjEzMnoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiLz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6I2E5YTlhOTtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6LjUyOTE2NjY0O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOm1pdGVyO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgZD0iTTYuMDg1IDI5MC42NWguMjY1VjI5N2gtLjI2NXoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiLz48ZyBzdHlsZT0iZmlsbDojMDAwO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDoyLjQ5MjEyNDU2IiB0cmFuc2Zvcm09Im1hdHJpeCguNDAxMjYgMCAwIC40MDEyNiAtLjk1MyAtLjYzNCkiPjxjaXJjbGUgc3R5bGU9InN0cm9rZS13aWR0aDoxIiBjeD0iNi45OTUiIGN5PSIzLjk2OSIgcj0iMS4wNTgiLz48cGF0aCBzdHlsZT0ic3Ryb2tlLXdpZHRoOjEiIGQ9Ik02Ljc0NiAxMy4yNnYyLjIxOGMwIC43MDUtMS4wNTguNzA1LTEuMDU4IDBWMTMuMjZINC4xNjFsMS43NzYtNi4zOGgtLjYxNEw0LjIwOCA5LjY1NmMtLjE5LjU5Mi0xLjA3Ny4zMzktLjkyNi0uMjY0TDQuNTMgNi4yMThjLjE2NS0uNTQxIDEuMTE0LS45MjMgMS44MDUtLjkyNmgxLjMyM2MuNjkuMDAzIDEuNjEuMzg1IDEuNzc1LjkyNmwxLjIxOCAzLjE3NWMuMTUxLjYwMy0uNzM2Ljg1Ni0uOTI2LjI2NEw4LjYzOSA2Ljg4aC0uNTg1bDEuODYzIDYuMzgxSDguMzl2Mi4yMThjMCAuNzA1LTEuMDU5LjcwNS0xLjA1OCAwVjEzLjI2eiIvPjxjaXJjbGUgc3R5bGU9InN0cm9rZS13aWR0aDoxIiBjeD0iMTMuODkxIiBjeT0iMy45NjkiIHI9IjEuMDU4Ii8+PHBhdGggc3R5bGU9InN0cm9rZS13aWR0aDoxIiBkPSJNMTAuOTcgNi42MTV2My40NGMwIC42MTcuOTI1LjYxNy45MjUgMFY3LjAxaC42NzNsLS4yMzMgOC40MDFjLS4wMjIuNzkzIDEuMTkuNzk0IDEuMTkgMHYtNC45NjFoLjY0NHY0Ljk2MWMwIC43OTQgMS4yMDQuNzk0IDEuMTkgMGwtLjE0NS04LjRoLjY0M3YzLjA0MmMwIC42MTguOTI2LjYxOC45MjYgMHYtMy40NGMwLS43My0uOTcxLTEuMzIyLTEuNzAyLTEuMzIySDEyLjdjLS43MyAwLTEuNzMuNTkyLTEuNzMgMS4zMjN6Ii8+PC9nPjwvc3ZnPg==';
const toiletsMaleIconUri =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PHBhdGggc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiNmZmY7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOiNhOWE5YTk7c3Ryb2tlLXdpZHRoOi4yNjQ1ODMzMjtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIGQ9Ik0uMTMyIDI5MC43ODJoNi4wODZ2Ni4wODZILjEzMnoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiLz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6I2E5YTlhOTtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6LjUyOTE2NjY0O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOm1pdGVyO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgZD0iTTYuMDg1IDI5MC42NWguMjY1VjI5N2gtLjI2NXoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiLz48ZyBzdHlsZT0iZmlsbDojMDAwO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDoyLjQ5MjEyNDU2IiB0cmFuc2Zvcm09Im1hdHJpeCguNDAxMjYgMCAwIC40MDEyNiAtMi4zOTMgLS42MzQpIj48Y2lyY2xlIHN0eWxlPSJzdHJva2Utd2lkdGg6MSIgY3g9IjEzLjg5MSIgY3k9IjMuOTY5IiByPSIxLjA1OCIvPjxwYXRoIHN0eWxlPSJzdHJva2Utd2lkdGg6MSIgZD0iTTEwLjk3IDYuNjE1djMuNDRjMCAuNjE3LjkyNS42MTcuOTI1IDBWNy4wMWguNjczbC0uMjMzIDguNDAxYy0uMDIyLjc5MyAxLjE5Ljc5NCAxLjE5IDB2LTQuOTYxaC42NDR2NC45NjFjMCAuNzk0IDEuMjA0Ljc5NCAxLjE5IDBsLS4xNDUtOC40aC42NDN2My4wNDJjMCAuNjE4LjkyNi42MTguOTI2IDB2LTMuNDRjMC0uNzMtLjk3MS0xLjMyMi0xLjcwMi0xLjMyMkgxMi43Yy0uNzMgMC0xLjczLjU5Mi0xLjczIDEuMzIzeiIvPjwvZz48L3N2Zz4=';
const toiletsFemaleIconUri =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDYuMzUgNi4zNSI+PHBhdGggc3R5bGU9Im9wYWNpdHk6MTtmaWxsOiNmZmY7ZmlsbC1vcGFjaXR5OjE7c3Ryb2tlOiNhOWE5YTk7c3Ryb2tlLXdpZHRoOi4yNjQ1ODMzMjtzdHJva2UtbGluZWNhcDpidXR0O3N0cm9rZS1saW5lam9pbjpyb3VuZDtzdHJva2UtbWl0ZXJsaW1pdDo0O3N0cm9rZS1kYXNoYXJyYXk6bm9uZTtzdHJva2UtZGFzaG9mZnNldDowO3N0cm9rZS1vcGFjaXR5OjEiIGQ9Ik0uMTMyIDI5MC43ODJoNi4wODZ2Ni4wODZILjEzMnoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiLz48cGF0aCBzdHlsZT0ib3BhY2l0eToxO2ZpbGw6I2E5YTlhOTtmaWxsLW9wYWNpdHk6MTtzdHJva2U6bm9uZTtzdHJva2Utd2lkdGg6LjUyOTE2NjY0O3N0cm9rZS1saW5lY2FwOmJ1dHQ7c3Ryb2tlLWxpbmVqb2luOm1pdGVyO3N0cm9rZS1taXRlcmxpbWl0OjQ7c3Ryb2tlLWRhc2hhcnJheTpub25lO3N0cm9rZS1kYXNob2Zmc2V0OjA7c3Ryb2tlLW9wYWNpdHk6MSIgZD0iTTYuMDg1IDI5MC42NWguMjY1VjI5N2gtLjI2NXoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAgLTI5MC42NSkiLz48ZyBzdHlsZT0iZmlsbDojMDAwO3N0cm9rZTpub25lO3N0cm9rZS13aWR0aDoyLjQ5MjEyNDU2IiB0cmFuc2Zvcm09Im1hdHJpeCguNDAxMjYgMCAwIC40MDEyNiAuMzggLS42MzQpIj48Y2lyY2xlIHN0eWxlPSJzdHJva2Utd2lkdGg6MSIgY3g9IjYuOTk1IiBjeT0iMy45NjkiIHI9IjEuMDU4Ii8+PHBhdGggc3R5bGU9InN0cm9rZS13aWR0aDoxIiBkPSJNNi43NDYgMTMuMjZ2Mi4yMThjMCAuNzA1LTEuMDU4LjcwNS0xLjA1OCAwVjEzLjI2SDQuMTYxbDEuNzc2LTYuMzhoLS42MTRMNC4yMDggOS42NTZjLS4xOS41OTItMS4wNzcuMzM5LS45MjYtLjI2NEw0LjUzIDYuMjE4Yy4xNjUtLjU0MSAxLjExNC0uOTIzIDEuODA1LS45MjZoMS4zMjNjLjY5LjAwMyAxLjYxLjM4NSAxLjc3NS45MjZsMS4yMTggMy4xNzVjLjE1MS42MDMtLjczNi44NTYtLjkyNi4yNjRMOC42MzkgNi44OGgtLjU4NWwxLjg2MyA2LjM4MUg4LjM5djIuMjE4YzAgLjcwNS0xLjA1OS43MDUtMS4wNTggMFYxMy4yNnoiLz48L2c+PC9zdmc+';

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

          const coords = geo.getCoordinates();
          const start = coords[coords.length - 2];
          const end = coords[coords.length - 1];
          const dx = end[0] - start[0];
          const dy = end[1] - start[1];
          const rotation = Math.atan2(dy, dx);
          const conveying: 'forward' | 'backward' = f.get('conveying');
          const level: string = f.get('level');
          stairsIconStyle.setGeometry(null);
          if (f.get('incline') === 'down') {
            stairsUpArrowhead.setGeometry(new Point(geo.getFirstCoordinate()));
            stairsUpArrowhead.getImage().setRotation(-rotation - 0.5 * Math.PI);
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
            stairsUpArrowhead.setGeometry(new Point(geo.getLastCoordinate()));
            stairsUpArrowhead.getImage().setRotation(-rotation - 1.5 * Math.PI);
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
