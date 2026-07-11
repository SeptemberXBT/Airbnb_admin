import { addMinutes, subMinutes } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

export type TurnoverReservation = {
  key: string;
  startDate: string;
  endDate: string;
  expectedCheckinTime: string | null;
  expectedCheckoutTime: string | null;
  cleaningDurationMinutes: number | null;
};

export type TurnoverProperty = {
  id: string;
  name: string;
  defaultCheckinTime: string;
  defaultCheckoutTime: string;
  defaultCleaningMinutes: number;
  checkoutBufferMinutes: number;
  checkinBufferMinutes: number;
  housekeepingCutoffTime: string;
  reservations: TurnoverReservation[];
};

export type DerivedTurnover = {
  key: string;
  propertyId: string;
  propertyName: string;
  outgoingEntryKey: string | null;
  incomingEntryKey: string | null;
  releaseTime: Date;
  readyDeadline: Date;
  guestArrivalTime: Date | null;
  durationMinutes: number;
};

const indiaInstant = (date: string, time: string) => fromZonedTime(`${date}T${time}:00`, "Asia/Kolkata");

export function deriveTurnovers(properties: TurnoverProperty[], serviceDate: string): DerivedTurnover[] {
  return properties.flatMap((property) => {
    const outgoing = property.reservations
      .filter((entry) => entry.endDate === serviceDate)
      .sort((a, b) => a.key.localeCompare(b.key))[0] ?? null;
    const incoming = property.reservations
      .filter((entry) => entry.startDate === serviceDate)
      .sort((a, b) => a.key.localeCompare(b.key))[0] ?? null;
    if (!outgoing && !incoming) return [];

    const releaseTime = outgoing
      ? addMinutes(indiaInstant(serviceDate, outgoing.expectedCheckoutTime ?? property.defaultCheckoutTime), property.checkoutBufferMinutes)
      : indiaInstant(serviceDate, "08:00");
    const guestArrivalTime = incoming
      ? indiaInstant(serviceDate, incoming.expectedCheckinTime ?? property.defaultCheckinTime)
      : null;
    const readyDeadline = guestArrivalTime
      ? subMinutes(guestArrivalTime, property.checkinBufferMinutes)
      : indiaInstant(serviceDate, property.housekeepingCutoffTime);
    return [{
      key: `${property.id}:${serviceDate}`,
      propertyId: property.id,
      propertyName: property.name,
      outgoingEntryKey: outgoing?.key ?? null,
      incomingEntryKey: incoming?.key ?? null,
      releaseTime,
      readyDeadline,
      guestArrivalTime,
      durationMinutes: outgoing?.cleaningDurationMinutes ?? incoming?.cleaningDurationMinutes ?? property.defaultCleaningMinutes,
    }];
  });
}
