def add(a, b):
    return a + b


if __name__ == "__main__":
    total = 0
    for i in range(5):
        total = add(total, i)  # breakpoint here
    print(f"total = {total}")
