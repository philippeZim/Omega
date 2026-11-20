fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let mut total = 0;
    for i in 0..5 {
        total = add(total, i); // breakpoint here
    }
    println!("total = {total}");
}

#[cfg(test)]
mod tests {
    #[test]
    fn adds() {
        assert_eq!(super::add(2, 2), 4);
    }
    #[test]
    fn fails() {
        assert_eq!(super::add(2, 2), 5, "deliberately failing");
    }
}
