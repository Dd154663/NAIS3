import {
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type SensorDescriptor,
  type SensorOptions
} from '@dnd-kit/core'

/**
 * 공용 dnd 센서 — 마우스는 기존 PointerSensor와 같은 distance 활성화,
 * 터치는 롱프레스(250ms)로 활성화해 스크롤과 드래그가 공존한다.
 * (PointerSensor 하나로는 터치에서 미세 이동만으로 드래그가 시작돼 스크롤을 막는다)
 */
export function useDndSensors(distance = 4): SensorDescriptor<SensorOptions>[] {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
  )
}
