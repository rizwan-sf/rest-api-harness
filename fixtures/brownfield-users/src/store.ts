export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export class UserStore {
  private readonly users = new Map<string, User>();
  private nextId = 1;

  list(): User[] {
    return [...this.users.values()];
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  findByEmail(email: string): User | undefined {
    return this.list().find((u) => u.email === email);
  }

  create(input: { email: string; name: string }): User {
    const user: User = { id: String(this.nextId++), ...input, createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    return user;
  }

  remove(id: string): boolean {
    return this.users.delete(id);
  }
}
