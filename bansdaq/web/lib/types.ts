export type UserDoc = {
  id: string;
  nickname: string;
  birthYear: number;
  officeCode: string;
  schoolCode: string;
  schoolName: string;
  ay: number;
  grade: string;
  classNm: string;
  classId: string;
  status: "pending" | "verified" | "held";
  approvals: string[];
  cash: number;
  principal: number;
  lastCheckin: string | null;
};

export type ClassDoc = {
  id: string;
  officeCode: string;
  schoolCode: string;
  schoolName: string;
  ay: number;
  grade: string;
  classNm: string;
  verifiedCount: number;
  listed: boolean;
  delisted?: boolean;
  price: number;
  prevClose: number;
  change: number;
  activity: number;
  volumeToday: number;
};

export type Holding = { uid: string; classId: string; qty: number; avgCost: number };

export type Trade = {
  classId: string; schoolName: string; grade: string; classNm: string;
  side: "buy" | "sell"; qty: number; price: number; fee: number;
  ts?: { toDate(): Date };
};

export type Rankings = {
  date: string;
  people: { nickname: string; school: string; cls: string; asset: number; ret: number }[];
  classes: { id: string; school: string; cls: string; cap: number; change: number }[];
  schools: { id: string; school: string; cap: number; classes: number }[];
};

export type School = { officeCode: string; schoolCode: string; name: string; kind: string; address: string };
