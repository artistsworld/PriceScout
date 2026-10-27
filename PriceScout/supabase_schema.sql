-- ==============================================================================
-- PriceScout — Supabase Schema & Row-Level Security (RLS) Setup
-- Run this in your Supabase Project: SQL Editor -> New Query -> Run
-- ==============================================================================

-- 1. Create the wishlist table
CREATE TABLE IF NOT EXISTS public.wishlist (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL DEFAULT auth.uid(),
    product_id TEXT NOT NULL,
    source TEXT NOT NULL, -- 'amazon' or 'flipkart'
    title TEXT NOT NULL,
    price INTEGER,
    original_price INTEGER,
    image TEXT,
    url TEXT NOT NULL,
    rating NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, product_id, source)
);

-- 2. Enable Row-Level Security (RLS)
ALTER TABLE public.wishlist ENABLE ROW LEVEL SECURITY;

-- 3. Create RLS Policies so each authenticated user can only view & modify their own wishlist
CREATE POLICY "Users can view their own wishlist items"
ON public.wishlist
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert items into their own wishlist"
ON public.wishlist
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own wishlist items"
ON public.wishlist
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- Optional: Create an index for speedy queries by user
CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON public.wishlist(user_id);
