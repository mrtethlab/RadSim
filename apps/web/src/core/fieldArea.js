/* The irradiated field of a fluoroscope: the round iris, cut by the shutter pair.

   The shutters are two parallel blades a distance 2s apart (rotatable), closing across the
   iris circle of radius R. What reaches the patient is the circle clipped to that band, and the
   dose-area product has to be measured over THAT — it used to take the whole circle, so closing
   the shutters, the one thing a careful operator does to cut DAP, did not move the meter.

   Band of half-width s through the centre of a circle of radius R:
       A = 2 [ s * sqrt(R^2 - s^2) + R^2 * asin(s / R) ]      (s < R),   pi R^2 otherwise.
   Units follow the inputs. */
export function irisShutterArea(R, s) {
  if (!(R > 0)) return 0;
  if (!(s >= 0)) s = 0;
  if (s >= R) return Math.PI * R * R;
  return 2 * (s * Math.sqrt(R * R - s * s) + R * R * Math.asin(s / R));
}
