import { db } from "../../lib/db.js";

export type NotificationDeliveryInput = {
  incidentId: number;
  eventType: string;
  destinationId: string;
  destinationName: string;
  success: boolean;
  statusCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
};

export type NotificationDeliveryRecord = {
  id: number;
  incident_id: number;
  event_type: string;
  destination_id: string;
  destination_name: string;
  success: number;
  status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  created_at: string;
};

export function recordNotificationDelivery(input: NotificationDeliveryInput): NotificationDeliveryRecord {
  const info = db
    .prepare(
      `
      INSERT INTO notification_deliveries (
        incident_id, event_type, destination_id, destination_name,
        success, status_code, response_body, error_message
      ) VALUES (
        @incident_id, @event_type, @destination_id, @destination_name,
        @success, @status_code, @response_body, @error_message
      )
    `,
    )
    .run({
      incident_id: input.incidentId,
      event_type: input.eventType,
      destination_id: input.destinationId,
      destination_name: input.destinationName,
      success: input.success ? 1 : 0,
      status_code: input.statusCode,
      response_body: input.responseBody,
      error_message: input.errorMessage,
    });

  return db.prepare("SELECT * FROM notification_deliveries WHERE id = ?").get(info.lastInsertRowid) as NotificationDeliveryRecord;
}

export function listDeliveriesForIncident(incidentId: number): NotificationDeliveryRecord[] {
  return db
    .prepare(
      `
      SELECT * FROM notification_deliveries
      WHERE incident_id = ?
      ORDER BY created_at DESC, id DESC
    `,
    )
    .all(incidentId) as NotificationDeliveryRecord[];
}
