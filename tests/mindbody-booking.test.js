// Mindbody booking rules (addAppointment) and the read-only lookups pay-first
// relies on. A booking POST is not idempotent: an unclear answer must never be
// followed by another POST, and a refused room must say so.

const mockApi = { post: jest.fn(), get: jest.fn() };
jest.mock('axios', () => ({ create: () => mockApi }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mb = require('../src/services/mindbody.service');

const reject = (status, message, code = 'Err') => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { Error: { Message: message, Code: code } } };
  return err;
};
const bookingPosts = () => mockApi.post.mock.calls.filter(c => c[0] === '/appointment/addappointment');

const BASE = { clientId: 7, sessionTypeId: 31, staffId: 5, startDateTime: '2026-10-16T14:00:00', notes: 'n' };

beforeEach(() => {
  mockApi.post.mockReset();
  mockApi.get.mockReset();
  mb.invalidateRoomOccupancy();
});

/** Script the booking POSTs in order; the token call always succeeds. */
function script(...outcomes) {
  const queue = [...outcomes];
  mockApi.post.mockImplementation(async (url) => {
    if (url === '/usertoken/issue') return { data: { AccessToken: 'tok' } };
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { data: { Appointment: next } };
  });
}

describe('addAppointment — rooms', () => {
  test('a refused room moves on to the next room', async () => {
    script(reject(400, 'Resource is not available'), { Id: 900 });
    const apt = await mb.addAppointment({ ...BASE, strictRooms: true });
    expect(apt.Id).toBe(900);
    expect(bookingPosts().map(c => c[1].ResourceIds)).toEqual([[3], [4]]);
  });

  test('all rooms refused on a pay-first type → ROOM_UNAVAILABLE, and never a booking without a room', async () => {
    script(reject(400, 'Resource is required'), reject(400, 'Resource is required'));
    await expect(mb.addAppointment({ ...BASE, strictRooms: true })).rejects.toMatchObject({ code: 'ROOM_UNAVAILABLE' });
    expect(bookingPosts()).toHaveLength(2);
    expect(bookingPosts().every(c => Array.isArray(c[1].ResourceIds))).toBe(true);
  });

  test('other treatments keep the old no-room fallback after room refusals', async () => {
    script(reject(400, 'Resource unavailable'), reject(400, 'Resource unavailable'), { Id: 901 });
    const apt = await mb.addAppointment({ ...BASE, sessionTypeId: 97 });
    expect(apt.Id).toBe(901);
    expect(bookingPosts()[2][1].ResourceIds).toBeUndefined();
  });

  test('the therapist refused in every room → the staff error itself (callers try other therapists)', async () => {
    script(reject(400, 'Staff member is not available'), reject(400, 'Staff member is not available'));
    const err = await mb.addAppointment({ ...BASE, strictRooms: true }).catch(e => e);
    expect(err.code).not.toBe('ROOM_UNAVAILABLE');
    expect(mb.isStaffRejection(err)).toBe(true);
  });

  test('the known-free room is tried first, and a requested therapist is marked as requested', async () => {
    script({ Id: 902 });
    await mb.addAppointment({ ...BASE, strictRooms: true, preferredResourceId: 4, staffRequested: true });
    expect(bookingPosts()[0][1]).toMatchObject({ ResourceIds: [4], StaffRequested: true });
  });
});

describe('addAppointment — unclear answers are never retried', () => {
  test('a 502 stops at once: no retry, no next room', async () => {
    script(reject(502, 'Bad gateway'));
    await expect(mb.addAppointment({ ...BASE, strictRooms: true })).rejects.toMatchObject({ code: 'BOOKING_OUTCOME_UNKNOWN' });
    expect(bookingPosts()).toHaveLength(1);
  });

  test('a timeout (no response) is an unknown outcome too', async () => {
    const timeout = new Error('timeout of 15000ms exceeded');
    timeout.code = 'ECONNABORTED';
    script(timeout);
    await expect(mb.addAppointment({ ...BASE, strictRooms: true })).rejects.toMatchObject({ code: 'BOOKING_OUTCOME_UNKNOWN' });
    expect(bookingPosts()).toHaveLength(1);
  });

  test('an expired token (401) is refreshed and the SAME room retried once', async () => {
    const unauthorized = new Error('401');
    unauthorized.response = { status: 401, data: {} };
    script(unauthorized, { Id: 903 });
    const apt = await mb.addAppointment({ ...BASE, strictRooms: true });
    expect(apt.Id).toBe(903);
    expect(bookingPosts().map(c => c[1].ResourceIds)).toEqual([[3], [3]]);
  });
});

describe('read-only lookups', () => {
  // Tara, 19 Nov 2026: the appointments endpoint gives a SessionTypeId, not a
  // name, and the team books types the bot does not sell.
  test('session type names: every type (no OnlineOnly), cached, and a failed refresh keeps the last good map', async () => {
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
      mockApi.get.mockResolvedValue({ data: { SessionTypes: [{ Id: 37, Name: 'Lymphatic Drainage Massage' }, { Id: 620, Name: 'Couples Ritual' }, { Id: 1 }] } });
      expect(await mb.getSessionTypeNames()).toEqual({ 37: 'Lymphatic Drainage Massage', 620: 'Couples Ritual' });
      expect(mockApi.get).toHaveBeenCalledWith('/site/sessiontypes', expect.objectContaining({ params: { Limit: 200 } }));

      // Cached: no second request within six hours.
      now.mockReturnValue(t0 + 5 * 60 * 60 * 1000);
      expect(await mb.getSessionTypeNames()).toEqual({ 37: 'Lymphatic Drainage Massage', 620: 'Couples Ritual' });
      expect(mockApi.get).toHaveBeenCalledTimes(1);

      // After six hours it refreshes; a failure keeps the last good map and never throws.
      now.mockReturnValue(t0 + 7 * 60 * 60 * 1000);
      mockApi.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } }));
      expect(await mb.getSessionTypeNames()).toEqual({ 37: 'Lymphatic Drainage Massage', 620: 'Couples Ritual' });
      expect(mockApi.get).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  // Review of the Tara fix: the name list is awaited inside every lookup. A
  // hanging endpoint must not hold the guest's answer, and a failing one must
  // not cost every lookup another request.
  test('session type names never hold a lookup for long, and a failure is remembered for a few minutes', async () => {
    let fresh;
    jest.isolateModules(() => { fresh = require('../src/services/mindbody.service'); });
    jest.useFakeTimers();
    try {
      mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
      let answer;
      mockApi.get.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      const first = fresh.getSessionTypeNames();
      await jest.advanceTimersByTimeAsync(2000);
      expect(await first).toEqual({});
      // The request finishes in the background and fills the cache.
      answer({ data: { SessionTypes: [{ Id: 620, Name: 'Couples Ritual' }] } });
      await jest.advanceTimersByTimeAsync(0);
      expect(await fresh.getSessionTypeNames()).toEqual({ 620: 'Couples Ritual' });
      expect(mockApi.get).toHaveBeenCalledTimes(1);

      let failing;
      jest.isolateModules(() => { failing = require('../src/services/mindbody.service'); });
      mockApi.get.mockReset();
      mockApi.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } }));
      expect(await failing.getSessionTypeNames()).toEqual({});
      expect(await failing.getSessionTypeNames()).toEqual({});
      expect(mockApi.get).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(6 * 60 * 1000);
      await failing.getSessionTypeNames();
      expect(mockApi.get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // Touriya review, Nov 2026: the booking tools take the address on this
  // profile as the guest's own. "The first row" is somebody else whenever
  // Mindbody ignores the id filter and answers with its first page of clients.
  test('getClientById returns only the profile that was asked for — never just the first row', async () => {
    mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
    mockApi.get.mockResolvedValue({ data: { Clients: [{ Id: '100000001', Email: 'someone.else@guest.fixture' }, { Id: '8', Email: 'hers@guest.fixture' }] } });
    expect(await mb.getClientById(8)).toEqual({ Id: '8', Email: 'hers@guest.fixture' });
    expect(mockApi.get).toHaveBeenCalledWith('/client/clients', expect.objectContaining({ params: { ClientIds: ['8'] } }));

    mockApi.get.mockResolvedValue({ data: { Clients: [{ Id: '100000001', Email: 'someone.else@guest.fixture' }] } });
    expect(await mb.getClientById(8)).toBeNull();
    mockApi.get.mockResolvedValue({ data: { Clients: [] } });
    expect(await mb.getClientById(8)).toBeNull();
  });

  test('room occupancy: cancelled appointments free their room, NoShow ones still count', async () => {
    mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
    mockApi.get.mockResolvedValue({ data: { Appointments: [
      { StartDateTime: '2026-10-16T13:00:00', EndDateTime: '2026-10-16T14:25:00', Status: 'Booked', Resources: [{ Id: 3 }] },
      { StartDateTime: '2026-10-16T13:00:00', EndDateTime: '2026-10-16T14:25:00', Status: 'Cancelled', Resources: [{ Id: 4 }] },
      { StartDateTime: '2026-10-16T15:00:00', EndDateTime: '2026-10-16T16:10:00', Status: 'NoShow', Resources: [{ Id: 1 }] },
    ] } });
    const occ = await mb.getRoomOccupancy('2026-10-16');
    expect(occ.known).toBe(true);
    expect([...occ.busy.keys()].sort()).toEqual([1, 3]);
  });

  test('room occupancy is unknown when Mindbody does not show rooms at all', async () => {
    mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
    mockApi.get.mockResolvedValue({ data: { Appointments: [{ StartDateTime: '2026-10-17T13:00:00', EndDateTime: '2026-10-17T14:00:00', Status: 'Booked' }] } });
    expect((await mb.getRoomOccupancy('2026-10-17')).known).toBe(false);
  });

  test('findClientAppointmentAt matches the start and type and ignores cancelled ones', async () => {
    mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
    mockApi.get.mockResolvedValue({ data: { Appointments: [
      { Id: 1, StartDateTime: '2026-10-16T14:00:00', SessionTypeId: 31, Status: 'Cancelled' },
      { Id: 2, StartDateTime: '2026-10-16T14:00:00', SessionTypeId: 31, Status: 'Booked' },
    ] } });
    expect((await mb.findClientAppointmentAt(7, '2026-10-16T14:00:00', 31)).Id).toBe(2);
    expect(await mb.findClientAppointmentAt(7, '2026-10-16T15:00:00', 31)).toBeNull();
  });

  test('a NoShow entry (how this site records cancels) is never taken for a booking', async () => {
    mockApi.post.mockResolvedValue({ data: { AccessToken: 'tok' } });
    mockApi.get.mockResolvedValue({ data: { Appointments: [
      { Id: 1, StartDateTime: '2026-10-18T14:00:00', SessionTypeId: 31, Status: 'NoShow' },
    ] } });
    expect(await mb.findClientAppointmentAt(7, '2026-10-18T14:00:00', 31)).toBeNull();
  });
});
